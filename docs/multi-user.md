# Accounts, invites and shared lists

NoorTasks serves a small group (a household, a friend group) from one server. Each person signs in with their own account and sees only their own data. Lists can be shared between members when the admin allows it.

## How it works

- **One database per person.** Every account has its own SQLite file and attachments folder. The single-user database of earlier versions stays where it is and becomes the first admin's account. Nothing is copied or converted.
- **A system database** (`noortasks-system.sqlite` next to your database) keeps the accounts, sessions, the invite list and the shares.
- **Invite only.** An admin adds email addresses in **Settings > Members**. Only those addresses can create an account with their first sign-in. A member limit (default 10) keeps a small server from being overloaded.
- **Sign in with Google** (or any OpenID Connect provider). Local passwords are an opt-in fallback and are off when OIDC is configured.

## Set up "Sign in with Google"

You need a Google account and about five minutes.

1. Open <https://console.cloud.google.com/> and create a project (top bar > project picker > **New project**, any name, for example `noortasks`).
2. Go to **APIs & Services > OAuth consent screen** (in the new console: **Google Auth Platform > Branding**). Choose **External**, enter the app name (`NoorTasks`), your support email and developer email, and save.
3. Under **Audience**, keep the publishing status **Testing** and add every member's Gmail address as a **test user** (up to 100). A small group never needs Google's app verification this way. Alternatively press **Publish app**: the scopes NoorTasks asks for (`openid email profile`) need no verification.
4. Go to **APIs & Services > Credentials** (or **Google Auth Platform > Clients**) > **Create credentials > OAuth client ID**.
   - Application type: **Web application**.
   - Name: `NoorTasks`.
   - **Authorized redirect URIs**: `https://<your host>/api/auth/oidc/callback`, for example `https://tasks.example.com/api/auth/oidc/callback`. It must match the `redirectUri` in the config exactly (scheme, host, port, path).
   - Authorized JavaScript origins: not needed.
5. Press **Create** and copy the **Client ID** and **Client secret**.
6. Write the config file (outside the repository, `chmod 600`):

```json
{
  "oidc": {
    "issuer": "https://accounts.google.com",
    "clientId": "<client id>.apps.googleusercontent.com",
    "clientSecret": "<client secret>",
    "redirectUri": "https://tasks.example.com/api/auth/oidc/callback",
    "label": "Google"
  },
  "admins": ["you@example.com"],
  "maxUsers": 10
}
```

7. Point `NOORTASKS_CONFIG` at it, set `NOORTASKS_SECURE_COOKIES=true` (HTTPS) and, behind a reverse proxy, `NOORTASKS_TRUST_PROXY=true`. Restart.
8. Sign in with the admin address. If you used NoorTasks before, all your data is there.
9. Invite people: **Settings > Members > Invite** with their Gmail address. They open the site and press **Sign in with Google**.

Google needs an https redirect URL with a real host name (a Tailscale `*.ts.net` name with HTTPS works; a bare IP does not).

### Android Google sign-in (system browser)

The Android app uses the same **Web application** OAuth client as the site, through a Chrome Custom Tab and a server-to-app one-time code. It requires the updated server and APK, an HTTPS server address, and a browser supporting Custom Tabs.

**Google Cloud Console check:** open **Google Auth Platform > Clients > NoorTasks** (the existing **Web application** client) > **Authorized redirect URIs** > **Add URI**, enter exactly `https://<your host>/api/auth/oidc/callback` if it is not already listed, and **Save**. This is the same URI as step 4 and `oidc.redirectUri`. There is **no additional Android OAuth client, signing SHA-1 or new Google redirect URI** for this flow. Do not add `app.noortasks://auth` to Google: Google returns to the HTTPS server, and only the server returns to the app. Existing correctly configured web clients need no console changes. Testing-mode members must still be added under **Audience > Test users** and invited in NoorTasks.

The app receives only a 60-second, one-time code bound to its own PKCE verifier and state. Redemption over HTTPS sets the app's session cookies; ID tokens and session cookies never appear in the return link. The usual verified-email, invite, account-status and member-limit checks apply. Web sign-in keeps its original behavior.

### Other providers (Authentik, Keycloak, Zitadel, ...)

Use the same `oidc` block with the provider's issuer URL (the URL whose `/.well-known/openid-configuration` exists), a confidential client with the authorization code flow, the redirect URL above, and the scopes `openid email profile`. The provider must return a verified `email` claim. Set `label` to the button text you want ("Sign in with <label>").

### Without OIDC (password fallback)

Leave out `oidc` and set `"passwordLogin": true` (the default without `oidc`). Inviting an email then shows a one-time invite code, valid for 7 days. The person opens the sign-in screen, chooses **Have an invite code?**, and picks a password. A `passphraseHash` from an older single-user config becomes the first admin's password, and the old passphrase-only sign-in keeps working for that account.

## Upgrading from the single-user version

Nothing to export. On the first start with a config that has `admins` (or the old `passphraseHash`), the existing database becomes the account of the first admin: the same file, the same user id, the same inbox. Sign in with that admin's Google address (or the old passphrase). The backup importer and exporter keep working on that file.

## Members (Settings > Members, admins only)

- **Invite / cancel invite**: the allowlist of emails that may join.
- **Turn off**: signs the member out and blocks sign-in. Data and shares stay.
- **Remove from server** (type the email to confirm): signs them out, takes them off the allowlist and out of every shared list. Their data stays on the server. **Restore** brings them back.
- **Delete data** (only for removed members, type the email again): deletes their database and files for good.
- **Collaboration switch** and **member limit**.

## Collaboration

When collaboration is on and a member has not opted out (**Settings > Collaborate**):

- **Share a list**: list menu (**...**) > **Share**. Pick a member and a permission: **Can edit** (add, edit, complete, delete, move tasks), **Can comment** (view and comment), **Can view**. The owner can change permissions, remove members, or **Make owner** (the list and its tasks, sections, comments and history move to the new owner, who keeps the old owner as an editor). A member can **Leave list**. The Inbox cannot be shared.
- **Assign**: in a shared list the task detail has an **Assign** button. Only members of that list can be assigned. **Assigned to Me** lists the tasks assigned to you.
- **Comments and mentions**: comments in a shared list notify the other members. Typing `@` offers the list's members; a mention raises a "mentioned you" notification. Members edit and delete only their own comments; the owner can delete any.
- **Activity and notifications**: activity entries name the member who acted. Assignments, shares, comments and mentions go to the bell's Notifications tab; edits by others in a shared list go to the Activities tab.
- **Sync**: shared lists arrive on every member's devices through the normal delta sync, offline edits included. When access ends, the list disappears from the member's devices (not into their trash).

**Switch off** (admin): sharing, assigning and new comments are hidden and refused. Existing shared lists stay visible to their members but become **read-only**. Nothing is deleted, and turning the switch back on restores every permission.

**Opt out** (per person): others cannot share lists with you or assign you, and the sharing controls are hidden for you. Lists already shared with you stay until you leave them.

## Known limits

- Attachments can only be added to tasks in your own lists. Files on tasks moved into someone else's list stay in the original account's folder.
- Kanban sections of a shared list are visible to the owner only. Members see the tasks in list view.
- The completed and trash views of a member show their own lists only.
- When a different account signs in on the same browser, changes the previous account had not synced yet are dropped from that browser (they are never sent as the new account).
- Each open account costs about 2.5 MB of server memory (measured: 116 MB with no accounts open, 140 MB with 10).
- Android Google sign-in needs an HTTPS server origin, the updated server, and a system browser supporting Custom Tabs. Device/Google-account sign-in must be checked on a real device; the automated suite uses a local OIDC provider.
