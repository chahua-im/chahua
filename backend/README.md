# Backend

## APNs setup

This backend talks to Apple Push Notification service directly using **token-based auth**.

It does **not** use an APNs TLS certificate in the current implementation. Instead, it expects an
Apple-issued `.p8` private key plus the associated key metadata.

### 1. Apple-side setup

1. In the Apple Developer portal, enable the **Push Notifications** capability for your app's
   App ID / bundle identifier.
2. Create an **APNs Auth Key** under **Certificates, Identifiers & Profiles -> Keys**.
3. Download the generated `.p8` file and store it securely. Apple only lets you download it once.
4. Record:
   - the **Key ID**
   - your Apple Developer **Team ID**
   - your app's **bundle identifier**; this backend uses it as `APNS_TOPIC`
5. In the iOS app, call `registerForRemoteNotifications()`, obtain the device token from APNs, and
   send that token to the backend's `/push/subscribe` endpoint.

### 2. Backend environment variables

The backend always requires the existing web-push configuration:

```env
VAPID_PUBLIC_KEY=...
VAPID_PRIVATE_KEY=...
VAPID_SUBJECT=mailto:push@example.com
```

To enable APNs support, set all of these:

```env
APNS_KEY_ID=ABCDEFGHIJ
APNS_TEAM_ID=ABCDEFGHIJ
APNS_PRIVATE_KEY_PATH=/absolute/path/to/AuthKey_ABCDEFGHIJ.p8
APNS_TOPIC=com.example.app
```

Notes:

- `APNS_PRIVATE_KEY_PATH` must point to the downloaded `.p8` key file on disk.
- `APNS_TOPIC` should be the iOS app bundle identifier used for push.
- APNs support is considered configured only when **all** `APNS_*` variables above are present.
- If APNs is not configured, `POST /push/subscribe` rejects `provider=apns`.

### 3. Environment handling

The backend stores APNs environment per subscription row:

- `sandbox`
- `production`

The iOS client must tell the backend which environment the token belongs to when subscribing.

### 4. API usage

Web push remains backward compatible:

- if `provider` is omitted, `/push/subscribe` treats the request as `webPush`

APNs subscriptions must include:

```json
{
  "provider": "apns",
  "deviceToken": "hex-device-token-from-ios",
  "environment": "sandbox"
}
```

or:

```json
{
  "provider": "apns",
  "deviceToken": "hex-device-token-from-ios",
  "environment": "production"
}
```

### 5. Localization behavior

APNs alert notifications are sent with localization keys/arguments, not pre-rendered translated
strings.

That means:

- the backend does not localize APNs message text
- the iOS app must ship the notification string resources referenced by the APNs payload

### 6. Operational notes

- One APNs signing key can be used for both sandbox and production.
- Protect the `.p8` file carefully; treat it like a production secret.
- Rotating the APNs key means creating a new key in Apple Developer, updating the env vars / key
  file on the backend, deploying, and only then revoking the old key.

## References

- Apple: [Registering your app with APNs](https://developer.apple.com/documentation/usernotifications/registering-your-app-with-apns)
- Apple: [Create a private key to access a service](https://developer.apple.com/help/account/keys/create-a-private-key/)
- Apple: [Communicate with APNs using authentication tokens](https://developer.apple.com/help/account/capabilities/communicate-with-apns-using-authentication-tokens/)
- Apple: [Establishing a certificate-based connection to APNs](https://developer.apple.com/documentation/usernotifications/establishing-a-certificate-based-connection-to-apns)



<!-- 不知道写啥啊啊啊啊啊啊啊啊 -->