## Authentication

Every request needs a bearer token:

    Authorization: Bearer <YOUR_API_KEY>

Create keys in the dashboard under Settings > API keys. Keys are shown once;
store them in an environment variable such as `ACME_API_KEY` rather than in
source control. Rotate a key by creating a new one and deleting the old one.
