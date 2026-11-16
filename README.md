# Doc-to-Markdown workflow

A small, runnable UI and API for moving files from a Docs table to Markdown with [Microsoft MarkItDown](https://github.com/microsoft/markitdown).

It is designed as a safe starter, not a browser-only converter:

```text
Docs table / trusted storage
        │
        ▼
Validate type, size, and file ownership
        │
        ▼
Background conversion job (MarkItDown)
        │
        ├── Markdown file storage
        └── status + error metadata back to the docs table
```

The included version uses a local SQLite `documents` table and a local storage directory, so it runs without any cloud setup. The conversion boundary is intentionally isolated in `app/main.py`; replace the repository/storage calls with your actual Docs-table provider when you connect it.

## What the UI does

- Upload PDF, DOCX, PPTX, XLSX, CSV, HTML, text, and common image files into the table.
- Browse documents with clear `Ready`, `Queued`, `Converting`, `Complete`, and `Failed` states.
- Convert one file or several selected files with MarkItDown in a server-side background job.
- Preview raw Markdown, copy it, or download it as a `.md` file.
- Keep conversion errors on the row and allow retrying.

## Run it locally

MarkItDown requires Python 3.10 or later. From this folder:

```bash
python3.11 -m venv .venv
source .venv/bin/activate
python -m pip install --upgrade pip
python -m pip install -r requirements.txt
uvicorn app.main:app --reload
```

Then open [http://127.0.0.1:8000](http://127.0.0.1:8000). The app creates its SQLite database and local upload/output folders on first start.

## API contract

| Endpoint | Purpose |
| --- | --- |
| `GET /api/documents` | List docs-table rows and conversion state. |
| `POST /api/documents` | Upload a file into the local docs table. Field name: `file`. |
| `POST /api/documents/{id}/convert` | Queue/reuse a conversion. |
| `GET /api/documents/{id}/markdown` | Fetch the converted Markdown. |
| `GET /api/conversions/{id}` | Poll a job's state. |
| `GET /api/conversions/{id}/download` | Download the resulting `.md` file. |

## Connecting your real Docs table

Keep the UI/API contract and replace only the local persistence operations in `app/main.py`:

1. Read a row by ID from your `docs` table, after checking the requesting user is authorized.
2. Fetch its bytes from your trusted storage provider using a storage key or signed server-side request — never accept arbitrary URLs from the browser.
3. Call MarkItDown with `convert_stream()` and a `StreamInfo` containing the original filename and MIME type.
4. Write the Markdown to object storage (or a `markdown_content` column), then update the source row's status, output key, checksum/version, timestamp, and error field.

A production `docs` row should have at least these fields:

```text
id, filename, mime_type, storage_key, checksum_or_version,
conversion_status, markdown_storage_key_or_content,
converted_at, conversion_error
```

For multiple app instances, replace FastAPI's local `BackgroundTasks` with a durable worker/queue such as Celery, RQ, Sidekiq-compatible service, or your platform's job runner. Deduplicate by `(document_id, checksum_or_version)` so unchanged files are not converted twice.

## Safety defaults

- Conversion happens on the server, not in the browser.
- Only a small allow-list of file extensions is accepted; the default max size is 50 MB (`MAX_FILE_BYTES` can override it).
- The app uses MarkItDown's `convert_stream()` with plugins disabled and never passes a user-controlled URL to the converter.
- Markdown is displayed as raw text in the UI, avoiding unsafe HTML rendering.

`storage/` and `data/documents.db` are runtime data and are ignored by Git.
