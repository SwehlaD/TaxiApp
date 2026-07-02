# Americab Taxi Salem App

Production-ready test build themed for Americab Taxi Salem with passenger, driver, and admin workflows.

## Run locally

```powershell
cd "C:\Users\dimas\Documents\Taxi App"
npm start
```

Open http://127.0.0.1:4173/

Phone testing on the same Wi-Fi usually uses:

http://172.26.51.92:4173/

## Test logins

Admin: 2223334444 / 1234
Driver: 3334445555 / 1234
Passenger: 4445556666 / 1234

## Production security upgrades included

- Passwords are stored as PBKDF2 hashes, not plaintext.
- Sign-in and account creation happen on the server.
- Browser sessions use signed tokens.
- /api/state requires authentication.
- Admin pricing changes are protected behind an authenticated admin session.
- Backups can be created through the admin-only /api/backup endpoint.
- Local file storage still works for testing.
- Postgres is supported when DATABASE_URL is set.

## Required deployment environment variables

APP_SECRET=use-a-long-random-secret
ADMIN_PHONE=2223334444
ADMIN_PASSWORD=change-this-before-public-use
DATABASE_URL=postgres://...

If DATABASE_URL is not set, the server falls back to taxi-data.json. That is okay for local testing but not for real production.

## Backups

POST /api/backup while signed in as admin to write a timestamped backup JSON file into the backups folder.

For hosted Postgres, also enable provider-level daily backups or snapshots.

## Before a real public launch

- Change the admin password.
- Use HTTPS hosting.
- Use a real Postgres database.
- Add SMS verification for phone ownership.
- Add Google Places Autocomplete/geocoding for verified pickup and destination locations.
- Add payment processing only after legal/business requirements are clear.

