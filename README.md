# TeamFlow

TeamFlow is a project management app with a Node.js backend, SQLite database, and email/password accounts.

## Requirements

- Node.js 22.5 or newer (Node.js 24 LTS recommended). The backend uses Node's built-in SQLite module, so no package install is needed.

## Run locally

```powershell
npm.cmd start
```

Open [http://localhost:3000](http://localhost:3000), create an account, and start using your workspace. The SQLite database is created automatically at `data/teamflow.sqlite`.

To use a different port or database file:

```powershell
$env:PORT = "3001"
$env:TEAMFLOW_DB = "C:\data\teamflow.sqlite"
npm.cmd start
```

Set `NODE_ENV=production` when serving over HTTPS to enable secure session cookies. Back up the SQLite database file regularly.

## Data and accounts

New accounts start with a private workspace and sample projects. Workspace owners can create an invitation code to let other accounts join; members can switch between workspaces, and projects and tasks are shared within the active workspace. Passwords are stored as salted scrypt hashes, and server-side sessions use random tokens stored as hashes in SQLite. Sessions expire after seven days.

The server provides account registration, login, logout, session lookup, workspace membership and invitations, and project/task create, read, update, and delete endpoints under `/api`.

Run `npm.cmd test` for the SQLite API integration tests.
