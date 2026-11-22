# Staff Firebase Auth provisioning

The Staff Management form can create a Firebase Authentication account through the
`createStaffAccount` callable function. It uses the function's Admin SDK identity;
no Admin SDK key is sent to the browser. The admin supplies an email and a temporary
password, which should be shared privately and changed by the staff member after sign-in.

Deploy the function with:

```powershell
firebase deploy --only functions:createStaffAccount
```

For staff profiles already in Firestore, prepare a private JSON file mapping each
existing `staff/{uid}` document to the staff member's real email:

```json
[
  { "uid": "existing-auth-uid", "email": "staff@example.com" }
]
```

From the `functions` directory, authenticate with Google Application Default
Credentials for the target Firebase project, then run:

```powershell
$env:FIREBASE_PROJECT_ID = "enpmenu"
node scripts/migrate-staff-auth.js --input staff-auth-migration.json --output staff-auth-reset-links.json
```

The migration preserves each Firestore staff document ID as the Firebase Auth UID,
creates missing accounts with random temporary passwords, and writes password-reset
links to the output file. Existing UID/email conflicts and inactive profiles are
reported rather than silently changed. Deliver reset links privately and delete the
local mapping and output files after use. Never commit either file.
