"""A small, safe local API for converting table-backed files with MarkItDown.

The `documents` SQLite table is intentionally the only data-source-specific part
of this sample. Replace the repository helpers below with your Docs-table and
storage client; the upload, job, and MarkItDown conversion flow can stay intact.
"""

from __future__ import annotations

import hashlib
import os
import sqlite3
import tempfile
import threading
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from fastapi import BackgroundTasks, FastAPI, File, HTTPException, UploadFile
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles


PROJECT_ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = PROJECT_ROOT / "data"
STORAGE_DIR = PROJECT_ROOT / "storage"
UPLOADS_DIR = STORAGE_DIR / "uploads"
MARKDOWN_DIR = STORAGE_DIR / "markdown"
STATIC_DIR = PROJECT_ROOT / "static"
DATABASE_PATH = DATA_DIR / "documents.db"

MAX_FILE_BYTES = int(os.environ.get("MAX_FILE_BYTES", 50 * 1024 * 1024))
SUPPORTED_EXTENSIONS = {
    ".pdf",
    ".docx",
    ".pptx",
    ".xlsx",
    ".xls",
    ".csv",
    ".html",
    ".htm",
    ".txt",
    ".md",
    ".jpg",
    ".jpeg",
    ".png",
    ".gif",
    ".bmp",
    ".tiff",
}

app = FastAPI(title="Doc-to-Markdown workflow", version="0.1.0")
_database_lock = threading.Lock()
DOCUMENT_SELECT = """
    SELECT documents.*, (
        SELECT id FROM conversions
        WHERE conversions.document_id = documents.id
        ORDER BY conversions.created_at DESC
        LIMIT 1
    ) AS conversion_id
    FROM documents
"""


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def ensure_runtime_directories() -> None:
    for directory in (DATA_DIR, UPLOADS_DIR, MARKDOWN_DIR):
        directory.mkdir(parents=True, exist_ok=True)


def get_connection() -> sqlite3.Connection:
    connection = sqlite3.connect(DATABASE_PATH)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA foreign_keys = ON")
    return connection


def initialize_database() -> None:
    ensure_runtime_directories()
    with _database_lock, get_connection() as connection:
        connection.executescript(
            """
            CREATE TABLE IF NOT EXISTS documents (
                id TEXT PRIMARY KEY,
                original_name TEXT NOT NULL,
                mime_type TEXT,
                size_bytes INTEGER NOT NULL,
                source_path TEXT NOT NULL,
                checksum TEXT NOT NULL,
                status TEXT NOT NULL DEFAULT 'ready',
                markdown_path TEXT,
                converted_at TEXT,
                last_error TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS conversions (
                id TEXT PRIMARY KEY,
                document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
                status TEXT NOT NULL,
                error TEXT,
                started_at TEXT,
                completed_at TEXT,
                created_at TEXT NOT NULL
            );

            CREATE INDEX IF NOT EXISTS idx_conversions_document_id
                ON conversions(document_id, created_at DESC);
            """
        )


def serialize_document(row: sqlite3.Row) -> dict[str, Any]:
    return {
        "id": row["id"],
        "name": row["original_name"],
        "mimeType": row["mime_type"] or "application/octet-stream",
        "sizeBytes": row["size_bytes"],
        "status": row["status"],
        "convertedAt": row["converted_at"],
        "error": row["last_error"],
        "createdAt": row["created_at"],
        "updatedAt": row["updated_at"],
        "hasMarkdown": bool(row["markdown_path"]),
        "conversionId": row["conversion_id"] if "conversion_id" in row.keys() else None,
    }


def get_document_or_404(document_id: str) -> sqlite3.Row:
    with get_connection() as connection:
        row = connection.execute(
            f"{DOCUMENT_SELECT} WHERE documents.id = ?", (document_id,)
        ).fetchone()
    if row is None:
        raise HTTPException(status_code=404, detail="Document not found.")
    return row


def serialize_conversion(row: sqlite3.Row | None) -> dict[str, Any] | None:
    if row is None:
        return None
    return {
        "id": row["id"],
        "documentId": row["document_id"],
        "status": row["status"],
        "error": row["error"],
        "startedAt": row["started_at"],
        "completedAt": row["completed_at"],
        "createdAt": row["created_at"],
    }


def safe_relative_path(value: str, expected_root: Path) -> Path:
    """Resolve an app-owned relative path without allowing path traversal."""
    candidate = (expected_root / value).resolve()
    if expected_root.resolve() not in candidate.parents:
        raise RuntimeError("Stored file path is outside the approved storage directory.")
    return candidate


def mark_document_failed(document_id: str, conversion_id: str, message: str) -> None:
    now = utc_now()
    with _database_lock, get_connection() as connection:
        connection.execute(
            """
            UPDATE documents
            SET status = 'failed', last_error = ?, updated_at = ?
            WHERE id = ?
            """,
            (message, now, document_id),
        )
        connection.execute(
            """
            UPDATE conversions
            SET status = 'failed', error = ?, completed_at = ?
            WHERE id = ?
            """,
            (message, now, conversion_id),
        )


def run_conversion(document_id: str, conversion_id: str) -> None:
    """Worker entrypoint. This runs after the job API responds to the browser."""
    now = utc_now()
    with _database_lock, get_connection() as connection:
        document = connection.execute(
            "SELECT * FROM documents WHERE id = ?", (document_id,)
        ).fetchone()
        if document is None:
            return
        connection.execute(
            "UPDATE documents SET status = 'converting', last_error = NULL, updated_at = ? WHERE id = ?",
            (now, document_id),
        )
        connection.execute(
            "UPDATE conversions SET status = 'converting', started_at = ? WHERE id = ?",
            (now, conversion_id),
        )

    try:
        # Import in the worker so the UI/API still starts and can show a useful
        # failed state if the optional conversion dependency is missing.
        from io import BytesIO

        from markitdown import MarkItDown, StreamInfo

        source_path = safe_relative_path(document["source_path"], UPLOADS_DIR)
        source_bytes = source_path.read_bytes()
        converter = MarkItDown(enable_plugins=False)
        result = converter.convert_stream(
            BytesIO(source_bytes),
            stream_info=StreamInfo(
                filename=document["original_name"],
                mimetype=document["mime_type"],
            ),
        )
        markdown = getattr(result, "markdown", None) or getattr(result, "text_content", None)
        if not isinstance(markdown, str):
            raise RuntimeError("MarkItDown returned no Markdown content.")

        markdown_relative_path = f"{document_id}.md"
        markdown_path = safe_relative_path(markdown_relative_path, MARKDOWN_DIR)
        # Prevent readers from ever seeing a partially written result.
        with tempfile.NamedTemporaryFile(
            mode="w", encoding="utf-8", delete=False, dir=MARKDOWN_DIR, suffix=".tmp"
        ) as temporary_file:
            temporary_file.write(markdown)
            temporary_name = temporary_file.name
        Path(temporary_name).replace(markdown_path)

        completed_at = utc_now()
        with _database_lock, get_connection() as connection:
            connection.execute(
                """
                UPDATE documents
                SET status = 'complete', markdown_path = ?, converted_at = ?,
                    last_error = NULL, updated_at = ?
                WHERE id = ?
                """,
                (markdown_relative_path, completed_at, completed_at, document_id),
            )
            connection.execute(
                """
                UPDATE conversions
                SET status = 'complete', completed_at = ?, error = NULL
                WHERE id = ?
                """,
                (completed_at, conversion_id),
            )
    except Exception as error:  # Convert failures should become a visible row state.
        message = str(error).strip() or error.__class__.__name__
        mark_document_failed(document_id, conversion_id, message[:1000])


@app.on_event("startup")
def startup() -> None:
    initialize_database()


@app.get("/api/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/api/documents")
def list_documents() -> dict[str, list[dict[str, Any]]]:
    with get_connection() as connection:
        rows = connection.execute(
            f"{DOCUMENT_SELECT} ORDER BY documents.updated_at DESC, documents.created_at DESC"
        ).fetchall()
    return {"documents": [serialize_document(row) for row in rows]}


@app.post("/api/documents", status_code=201)
async def upload_document(file: UploadFile = File(...)) -> dict[str, Any]:
    filename = Path(file.filename or "untitled").name
    suffix = Path(filename).suffix.lower()
    if suffix not in SUPPORTED_EXTENSIONS:
        supported = ", ".join(sorted(SUPPORTED_EXTENSIONS))
        raise HTTPException(
            status_code=415,
            detail=f"Unsupported file type. Choose one of: {supported}",
        )

    contents = await file.read(MAX_FILE_BYTES + 1)
    if not contents:
        raise HTTPException(status_code=422, detail="The uploaded file is empty.")
    if len(contents) > MAX_FILE_BYTES:
        raise HTTPException(
            status_code=413,
            detail=f"File is larger than the {MAX_FILE_BYTES // (1024 * 1024)} MB limit.",
        )

    document_id = str(uuid.uuid4())
    source_relative_path = f"{document_id}{suffix}"
    source_path = safe_relative_path(source_relative_path, UPLOADS_DIR)
    source_path.write_bytes(contents)
    now = utc_now()
    mime_type = file.content_type or "application/octet-stream"

    try:
        with _database_lock, get_connection() as connection:
            connection.execute(
                """
                INSERT INTO documents (
                    id, original_name, mime_type, size_bytes, source_path, checksum,
                    status, created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, 'ready', ?, ?)
                """,
                (
                    document_id,
                    filename,
                    mime_type,
                    len(contents),
                    source_relative_path,
                    hashlib.sha256(contents).hexdigest(),
                    now,
                    now,
                ),
            )
    except Exception:
        source_path.unlink(missing_ok=True)
        raise

    return {"document": serialize_document(get_document_or_404(document_id))}


@app.post("/api/documents/{document_id}/convert")
def convert_document(
    document_id: str, background_tasks: BackgroundTasks
) -> dict[str, Any]:
    conversion_id = str(uuid.uuid4())
    now = utc_now()
    reused_response: dict[str, Any] | None = None
    with _database_lock, get_connection() as connection:
        # Read and claim the job in the same lock/transaction. Without this,
        # two rapid clicks could both observe a `ready` row and enqueue work.
        document = connection.execute(
            "SELECT * FROM documents WHERE id = ?", (document_id,)
        ).fetchone()
        if document is None:
            raise HTTPException(status_code=404, detail="Document not found.")
        latest_conversion = connection.execute(
            """
            SELECT * FROM conversions
            WHERE document_id = ?
            ORDER BY created_at DESC
            LIMIT 1
            """,
            (document_id,),
        ).fetchone()

        if document["status"] in {"queued", "converting"}:
            reused_response = {
                "document": serialize_document(document),
                "conversion": serialize_conversion(latest_conversion),
                "reused": True,
            }
        elif document["status"] == "complete" and document["markdown_path"]:
            markdown_path = safe_relative_path(document["markdown_path"], MARKDOWN_DIR)
            if markdown_path.is_file():
                reused_response = {
                    "document": serialize_document(document),
                    "conversion": serialize_conversion(latest_conversion),
                    "reused": True,
                }
            else:
                # A manually removed or expired output can safely be regenerated.
                connection.execute(
                    """
                    UPDATE documents
                    SET status = 'ready', markdown_path = NULL, converted_at = NULL,
                        last_error = NULL, updated_at = ?
                    WHERE id = ?
                    """,
                    (now, document_id),
                )

        if reused_response is None:
            connection.execute(
                "UPDATE documents SET status = 'queued', last_error = NULL, updated_at = ? WHERE id = ?",
                (now, document_id),
            )
            connection.execute(
                """
                INSERT INTO conversions (id, document_id, status, created_at)
                VALUES (?, ?, 'queued', ?)
                """,
                (conversion_id, document_id, now),
            )

    if reused_response is not None:
        return reused_response

    background_tasks.add_task(run_conversion, document_id, conversion_id)
    queued_document = get_document_or_404(document_id)
    return {
        "document": serialize_document(queued_document),
        "conversion": {
            "id": conversion_id,
            "documentId": document_id,
            "status": "queued",
            "error": None,
            "startedAt": None,
            "completedAt": None,
            "createdAt": now,
        },
        "reused": False,
    }


@app.get("/api/documents/{document_id}/markdown")
def get_markdown(document_id: str) -> dict[str, Any]:
    document = get_document_or_404(document_id)
    if document["status"] != "complete" or not document["markdown_path"]:
        raise HTTPException(
            status_code=409,
            detail="Markdown is not ready for this document yet.",
        )
    markdown_path = safe_relative_path(document["markdown_path"], MARKDOWN_DIR)
    if not markdown_path.is_file():
        raise HTTPException(status_code=410, detail="The Markdown output is unavailable.")
    return {
        "document": serialize_document(document),
        "markdown": markdown_path.read_text(encoding="utf-8"),
    }


@app.get("/api/conversions/{conversion_id}")
def get_conversion(conversion_id: str) -> dict[str, Any]:
    with get_connection() as connection:
        conversion = connection.execute(
            "SELECT * FROM conversions WHERE id = ?", (conversion_id,)
        ).fetchone()
    if conversion is None:
        raise HTTPException(status_code=404, detail="Conversion not found.")
    return {"conversion": serialize_conversion(conversion)}


@app.get("/api/conversions/{conversion_id}/download")
def download_markdown(conversion_id: str) -> FileResponse:
    with get_connection() as connection:
        conversion = connection.execute(
            "SELECT * FROM conversions WHERE id = ?", (conversion_id,)
        ).fetchone()
        if conversion is None:
            raise HTTPException(status_code=404, detail="Conversion not found.")
        document = connection.execute(
            "SELECT * FROM documents WHERE id = ?", (conversion["document_id"],)
        ).fetchone()
    if conversion["status"] != "complete" or document is None or not document["markdown_path"]:
        raise HTTPException(status_code=409, detail="Markdown is not ready for download yet.")

    markdown_path = safe_relative_path(document["markdown_path"], MARKDOWN_DIR)
    if not markdown_path.is_file():
        raise HTTPException(status_code=410, detail="The Markdown output is unavailable.")
    download_name = f"{Path(document['original_name']).stem or 'document'}.md"
    return FileResponse(
        markdown_path,
        media_type="text/markdown; charset=utf-8",
        filename=download_name,
    )


if STATIC_DIR.is_dir():
    app.mount("/", StaticFiles(directory=STATIC_DIR, html=True), name="static")
