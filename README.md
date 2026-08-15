# fileupload

A small self-hosted service for uploading a file and getting a public link back. It includes:

- API-key-protected uploads
- A responsive dashboard for uploading, listing, copying, and deleting files
- API-key rotation and configurable storage for future uploads
- Inline browser previews for images, video, audio, PDFs, and plain text
- Range request support for media playback
- A production Docker image and health check

## Run locally

```bash
cp .env.example .env
# Edit .env and set a random INITIAL_API_KEY with at least 16 characters.
set -a && source .env && set +a
npm install
npm start
```

Open `http://localhost:3000` and sign in with `INITIAL_API_KEY`. The initial key is only read the first time a data directory is initialized. Settings and file metadata live in `DATA_DIR`.

## Upload API

Authentication accepts `X-API-Key` or a Bearer token. Upload either a multipart file in the field named `file`:

```bash
curl -X POST https://f.aychar.dev/api/upload \
  -H "X-API-Key: $FILEUPLOAD_API_KEY" \
  -F "file=@./photo.jpg"
```

Or send the file as the entire request body, which is useful for Apple Shortcuts:

```bash
curl -X POST https://f.aychar.dev/api/upload \
  -H "X-API-Key: $FILEUPLOAD_API_KEY" \
  -H "Content-Type: image/jpeg" \
  -H "X-Filename: photo.jpg" \
  --data-binary @./photo.jpg
```

`X-Filename` is optional for raw uploads. Without it, the service generates a filename with an extension inferred from `Content-Type`.

Successful responses use HTTP 201:

```json
{
  "id": "h12KLB5x",
  "name": "photo.jpg",
  "type": "image/jpeg",
  "size": 284103,
  "createdAt": "2026-08-14T20:00:00.000Z",
  "url": "https://f.aychar.dev/a/h12KLB5x"
}
```

`POST /upload` is also available as a short alias. The maximum upload size defaults to 1 GiB and can be changed with `MAX_UPLOAD_BYTES`.

## Docker

```bash
docker build -t fileupload .
docker run --rm -p 3000:3000 \
  -e INITIAL_API_KEY='replace-with-a-long-random-secret' \
  -e PUBLIC_URL='https://f.aychar.dev' \
  -v fileupload-data:/data \
  fileupload
```

Keep `/data` on persistent storage. The dashboard storage setting accepts an absolute path inside the container; when using the included image, paths below `/data` are persistent. Changing the path only affects future uploads, so links to existing files remain valid.

## Environment

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3000` | HTTP listen port |
| `DATA_DIR` | `./data` | Persistent metadata directory |
| `INITIAL_API_KEY` | required on first start | Initial dashboard/upload credential (minimum 16 characters) |
| `PUBLIC_URL` | request origin | Canonical base URL returned by the upload API |
| `MAX_UPLOAD_BYTES` | `1073741824` | Per-file upload limit |

## Apple Shortcut

See [APPLE_SHORTCUT.md](APPLE_SHORTCUT.md) for the phone shortcut recipe. It uses Shortcuts' native **File** request body, copies the public URL, and shows the result.

## Security notes

- Only a salted scrypt hash of the API key is persisted.
- Dashboard sessions are HTTP-only, SameSite cookies and are invalidated on key rotation.
- Uploaded active content such as HTML and SVG downloads instead of rendering on the dashboard's origin.
- File IDs are random and public links are intentionally accessible without authentication.
- Public IDs are 8 case-sensitive alphanumeric characters. Changing to this format invalidated the former `/f/...` link format.

Back up the entire data directory, not only the uploads folder; metadata maps public IDs to stored files.

## Test

```bash
npm test
```
