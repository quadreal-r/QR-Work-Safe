# GitHub remote (Windows ↔ Mac)

Use a **private** GitHub repo as the transport between your Windows machine and Mac (for future iOS builds).

## One-time setup

Repo: **https://github.com/quadreal-r/QR-Work-Safe**

Local folder name is `QR-Work Safe`; the GitHub name uses a hyphen.

```bash
git remote add origin https://github.com/quadreal-r/QR-Work-Safe.git
git push -u origin main
```

On a Mac:

```bash
git clone https://github.com/quadreal-r/QR-Work-Safe.git
cd QR-Work-Safe
npm install
npm run sync
```
