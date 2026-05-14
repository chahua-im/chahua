import Flutter
import UIKit
import UserNotifications

/// Native MethodChannel plugin for APNs push notifications.
///
/// Handles permission requests, device token forwarding, notification tap
/// events, and foreground suppression when the user is viewing the relevant chat.
class PushNotificationPlugin: NSObject, FlutterPlugin, UNUserNotificationCenterDelegate {
    static let channelName = "app.chahua.chat/push_notifications"

    private let channel: FlutterMethodChannel

    /// Pending device token to forward once the channel is ready.
    private var pendingDeviceToken: String?
    private var pendingDeviceTokenError: String?

    /// The notification response that launched the app (cold start).
    private var launchNotificationPayload: [String: Any]?

    init(channel: FlutterMethodChannel) {
        self.channel = channel
        super.init()
    }

    /// Called by AppDelegate to hand off a notification payload that arrived
    /// before the plugin was initialized (cold-start tap).
    func setLaunchNotification(_ payload: [String: Any]) {
        launchNotificationPayload = payload
    }

    // MARK: - FlutterPlugin

    static func register(with registrar: FlutterPluginRegistrar) {
        // Registration is handled manually in AppDelegate since we need
        // access to the shared instance for forwarding APNs callbacks.
    }

    func handle(_ call: FlutterMethodCall, result: @escaping FlutterResult) {
        switch call.method {
        case "requestPermission":
            requestPermission(result: result)
        case "getPermissionStatus":
            getPermissionStatus(result: result)
        case "registerForRemoteNotifications":
            DispatchQueue.main.async {
                UIApplication.shared.registerForRemoteNotifications()
            }
            result(nil)
        case "unregisterForRemoteNotifications":
            DispatchQueue.main.async {
                UIApplication.shared.unregisterForRemoteNotifications()
            }
            result(nil)
        case "getApnsEnvironment":
            result(Self.detectApnsEnvironment())
        case "setBadge":
            let count = (call.arguments as? [String: Any])?["count"] as? Int ?? 0
            setBadge(count)
            result(nil)
        case "clearBadge":
            setBadge(0)
            result(nil)
        case "dismissDeliveredNotificationsForConversation":
            guard let args = call.arguments as? [String: Any],
                  let chatId = args["chatId"] as? String
            else {
                result(FlutterError(
                    code: "INVALID_ARGUMENTS",
                    message: "chatId is required",
                    details: nil
                ))
                return
            }
            let threadRootId = args["threadRootId"] as? String
            dismissDeliveredNotificationsForConversation(
                chatId: chatId,
                threadRootId: threadRootId,
                result: result
            )
        case "getLaunchNotification":
            if let payload = launchNotificationPayload {
                launchNotificationPayload = nil
                result(payload)
            } else {
                result(nil)
            }
        default:
            result(FlutterMethodNotImplemented)
        }
    }

    // MARK: - Permission

    private func requestPermission(result: @escaping FlutterResult) {
        let center = UNUserNotificationCenter.current()
        center.requestAuthorization(options: [.alert, .badge, .sound]) { granted, error in
            if let error = error {
                result(FlutterError(
                    code: "PERMISSION_ERROR",
                    message: error.localizedDescription,
                    details: nil
                ))
                return
            }
            center.getNotificationSettings { settings in
                DispatchQueue.main.async {
                    result([
                        "granted": granted,
                        "status": Self.statusString(from: settings.authorizationStatus),
                    ])
                }
            }
        }
    }

    private func getPermissionStatus(result: @escaping FlutterResult) {
        UNUserNotificationCenter.current().getNotificationSettings { settings in
            DispatchQueue.main.async {
                result(Self.statusString(from: settings.authorizationStatus))
            }
        }
    }

    private static func statusString(from status: UNAuthorizationStatus) -> String {
        switch status {
        case .authorized: return "authorized"
        case .denied: return "denied"
        case .provisional: return "provisional"
        case .notDetermined: return "notDetermined"
        case .ephemeral: return "ephemeral"
        @unknown default: return "unknown"
        }
    }

    // MARK: - Device Token

    func didRegisterForRemoteNotifications(deviceToken: Data) {
        let hex = deviceToken.map { String(format: "%02x", $0) }.joined()
        channel.invokeMethod("onDeviceTokenReceived", arguments: ["deviceToken": hex])
    }

    func didFailToRegisterForRemoteNotifications(error: Error) {
        channel.invokeMethod("onDeviceTokenError", arguments: ["error": error.localizedDescription])
    }

    // MARK: - UNUserNotificationCenterDelegate

    /// Called when a notification arrives while the app is in the foreground.
    /// All banners are suppressed — the in-app UI handles new messages.
    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification,
        withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
    ) {
        completionHandler([])
    }

    /// Called when the user taps a notification.
    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse,
        withCompletionHandler completionHandler: @escaping () -> Void
    ) {
        let userInfo = response.notification.request.content.userInfo

        if let wettyChatData = userInfo["wettyChat"] as? [String: Any] {
            channel.invokeMethod("onNotificationTapped", arguments: wettyChatData)
        }

        completionHandler()
    }

    // MARK: - Badge

    private func setBadge(_ count: Int) {
        DispatchQueue.main.async {
            if #available(iOS 16.0, *) {
                UNUserNotificationCenter.current().setBadgeCount(count)
            }
            UIApplication.shared.applicationIconBadgeNumber = count
        }
    }

    private func dismissDeliveredNotificationsForConversation(
        chatId: String,
        threadRootId: String?,
        result: @escaping FlutterResult
    ) {
        let center = UNUserNotificationCenter.current()
        center.getDeliveredNotifications { notifications in
            let identifiers = notifications
                .filter { self.matchesConversation($0, chatId: chatId, threadRootId: threadRootId) }
                .map { $0.request.identifier }

            if !identifiers.isEmpty {
                center.removeDeliveredNotifications(withIdentifiers: identifiers)
            }

            DispatchQueue.main.async {
                result(nil)
            }
        }
    }

    private func matchesConversation(
        _ notification: UNNotification,
        chatId: String,
        threadRootId: String?
    ) -> Bool {
        let expectedThreadIdentifier: String
        if let threadRootId = threadRootId, !threadRootId.isEmpty {
            expectedThreadIdentifier = "chat_\(chatId)_thread_\(threadRootId)"
        } else {
            expectedThreadIdentifier = "chat_\(chatId)"
        }

        if notification.request.content.threadIdentifier == expectedThreadIdentifier {
            return true
        }

        guard let wettyChatData = notification.request.content.userInfo["wettyChat"] as? [String: Any],
              Self.stringValue(wettyChatData["chatId"]) == chatId
        else {
            return false
        }

        let notificationThreadRootId = Self.stringValue(wettyChatData["threadRootId"])
        if let threadRootId = threadRootId, !threadRootId.isEmpty {
            return notificationThreadRootId == threadRootId
        }
        return notificationThreadRootId == nil || notificationThreadRootId?.isEmpty == true
    }

    private static func stringValue(_ value: Any?) -> String? {
        switch value {
        case let string as String:
            return string
        case let number as NSNumber:
            return number.stringValue
        default:
            return nil
        }
    }

    // MARK: - Environment Detection

    static func detectApnsEnvironment() -> String {
        // The embedded.mobileprovision is a CMS/PKCS7 container with an XML
        // plist embedded as plaintext bytes. App Store builds strip this file
        // entirely, so its absence means production.
        guard let provisionURL = Bundle.main.url(forResource: "embedded", withExtension: "mobileprovision"),
              let provisionData = try? Data(contentsOf: provisionURL)
        else {
            // App Store builds strip the provisioning profile.
            return "production"
        }

        // Scan the raw bytes for the XML plist markers. We can't decode the
        // entire file as ASCII/UTF-8 because the CMS binary envelope contains
        // invalid characters that cause String(data:encoding:) to return nil.
        let xmlOpen = "<?xml".data(using: .utf8)!
        let xmlClose = "</plist>".data(using: .utf8)!

        guard let startRange = provisionData.range(of: xmlOpen),
              let endRange = provisionData.range(of: xmlClose, in: startRange.lowerBound..<provisionData.endIndex),
              let plist = try? PropertyListSerialization.propertyList(
                  from: provisionData[startRange.lowerBound..<endRange.upperBound],
                  format: nil
              ) as? [String: Any]
        else {
            return "production"
        }

        // Development profiles list specific device UDIDs in ProvisionedDevices.
        // Ad Hoc / Enterprise use ProvisionsAllDevices. App Store has neither.
        // We check this instead of aps-environment because that field is an
        // allowlist and distribution profiles always say "production" there.
        let isDev = plist["ProvisionedDevices"] != nil
        let result = isDev ? "sandbox" : "production"
        NSLog("[APNs] environment=%@ profile=%@", result, plist["Name"] as? String ?? "unknown")
        return result
    }
}
