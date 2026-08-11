# wetty-chat-flutter

Flutter client for wetty-chat.

## API base URL

The app reads the API base URL from a compile-time define:

```dart
const String apiBaseUrl = String.fromEnvironment(
  'API_BASE_URL',
  defaultValue: 'https://chahui.app/_api',
);
```

If `API_BASE_URL` is not provided, the app uses `https://chahui.app/_api`.

## Run with a development API

From the terminal:

```bash
flutter run --dart-define=API_BASE_URL=http://wchat.i386.mov/_api
```

## Generate DTO serializers

JSON DTOs under `lib/core/api/models` use `json_serializable` and are generated
with `build_runner`.

Generate them once:

```bash
dart run build_runner build --delete-conflicting-outputs
```

Regenerate automatically while editing DTOs:

```bash
dart run build_runner watch --delete-conflicting-outputs
```

Run these commands from `wetty-chat-flutter/`.

`flutter run` and `flutter build` do not run this DTO code generation
automatically. Also note that `flutter: generate: true` is for Flutter's own
generators such as localization, not `json_serializable`.

## VS Code

Use a launch configuration that passes `--dart-define` to the Flutter tool:

```json
"toolArgs": [
  "--dart-define",
  "API_BASE_URL=http://your-local-api:3000"
]
```

Do a full restart after changing it. Hot reload does not change compile-time defines.

The app prints the active API URL once at startup so you can confirm the define was applied:

```text
[APP] API_BASE_URL=...
```

# iOS Development Signing Setup (fastlane + match)

This project uses **fastlane + match** to manage iOS development certificates and provisioning profiles.

The goal is:

* ✅ Consistent signing setup across machines
* ✅ No manual certificate/provisioning management
* ✅ Secure storage in a private repo

---

## 🧩 Prerequisites

Before starting, make sure you have:

* macOS
* Xcode (full app installed)
* Homebrew installed
* Access to the private signing repo
* The shared `MATCH_PASSWORD`

---

## 🛠 1. Install Ruby (via rbenv)

We use a project-local Ruby to avoid macOS system Ruby issues.

```bash
brew install rbenv ruby-build
```

Add to your `~/.zshrc`:

```bash
export PATH="$HOME/.rbenv/bin:$PATH"
eval "$(rbenv init - zsh)"
```

Reload shell:

```bash
source ~/.zshrc
```

Install Ruby:

```bash
rbenv install 3.2.2
rbenv global 3.2.2
rbenv rehash
```

Verify:

```bash
ruby -v
which ruby
```

---

## 📦 2. Install dependencies

From the project root:

```bash
gem install bundler
bundle install
```

---

## 🍎 3. Setup Xcode (IMPORTANT)

Make sure Xcode is properly selected:

```bash
sudo xcode-select -s /Applications/Xcode.app/Contents/Developer
sudo xcodebuild -runFirstLaunch
```

Verify:

```bash
xcodebuild -version
```

---

## 🔐 4. Configure environment variables

You need access to the signing repo and encryption password.

Set these:

```bash
export MATCH_GIT_URL="git@github.com:Codetector1374/apple_developer_certs.git"
export MATCH_PASSWORD="(ask project owner)"
```

You may want to add these to your `~/.zshrc`.

---

## 🔄 5. Sync development signing

From the `ios/` directory:

```bash
cd ios
bundle exec fastlane ios sync_dev_signing
```

This will:

* Download/install the development certificate
* Install provisioning profiles
* Configure your machine for device testing

---

## 📱 6. Open in Xcode

Open:

```
ios/Runner.xcworkspace
```

Then:

* Go to **Signing & Capabilities**
* Enable **Automatically manage signing**
* Select the correct **Team**

Now you should be able to run on a real device 🎉

---

## 🔁 Updating provisioning profiles (new devices)

If a new device is added:

```bash
cd ios
bundle exec fastlane ios sync_dev_signing
```

This will regenerate/update profiles automatically.

---

## 🧭 Daily workflow

After initial setup, you usually don’t need to think about signing.

If something breaks:

```bash
cd ios
bundle exec fastlane ios sync_dev_signing
```

---

## 🚨 Troubleshooting

### “Unable to locate Xcode”

Run:

```bash
sudo xcode-select -s /Applications/Xcode.app/Contents/Developer
```

---

### Ruby / bundler issues

Make sure you're using rbenv Ruby:

```bash
which ruby
```

Should point to:

```
~/.rbenv/shims/ruby
```

---

### Permissions errors (`/Library/Ruby/...`)

You're using system Ruby — fix rbenv setup.

---

### Fastlane not found

Always run:

```bash
bundle exec fastlane ...
```

---

## 🔒 Notes

* The signing repo is **encrypted**
* Never commit certificates to this repo
* Never share `MATCH_PASSWORD` publicly

---

## 👍 Summary

Setup once:

```bash
bundle install
cd ios
bundle exec fastlane ios sync_dev_signing
```

Then just build and run 🚀
