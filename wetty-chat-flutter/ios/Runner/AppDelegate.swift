import Flutter
import UIKit
import UserNotifications

@main
@objc class AppDelegate: FlutterAppDelegate, FlutterImplicitEngineDelegate {
  private var pushPlugin: PushNotificationPlugin?
  private var pendingNotificationPayload: [String: Any]?

  override func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?
  ) -> Bool {
    // Flutter can leave iOS with a visible keyboard but no focused text field
    // after native dialogs such as Shake to Undo.
    // Keep this until https://github.com/flutter/flutter/issues/150522 is fixed.
    application.applicationSupportsShakeToEdit = false
    UNUserNotificationCenter.current().delegate = self
    return super.application(application, didFinishLaunchingWithOptions: launchOptions)
  }

  func didInitializeImplicitFlutterEngine(_ engineBridge: FlutterImplicitEngineBridge) {
    GeneratedPluginRegistrant.register(with: engineBridge.pluginRegistry)

    if let registrar = engineBridge.pluginRegistry.registrar(forPlugin: "PushNotificationPlugin") {
      let channel = FlutterMethodChannel(
        name: PushNotificationPlugin.channelName,
        binaryMessenger: registrar.messenger()
      )
      let plugin = PushNotificationPlugin(channel: channel)
      channel.setMethodCallHandler(plugin.handle)
      pushPlugin = plugin

      // Hand off any notification payload that arrived during cold start.
      if let pending = pendingNotificationPayload {
        plugin.setLaunchNotification(pending)
        pendingNotificationPayload = nil
      }
    }
  }

  // MARK: - APNs Callbacks

  override func application(
    _ application: UIApplication,
    didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data
  ) {
    pushPlugin?.didRegisterForRemoteNotifications(deviceToken: deviceToken)
  }

  override func application(
    _ application: UIApplication,
    didFailToRegisterForRemoteNotificationsWithError error: Error
  ) {
    pushPlugin?.didFailToRegisterForRemoteNotifications(error: error)
  }

  // MARK: - UNUserNotificationCenterDelegate forwarding

  override func userNotificationCenter(
    _ center: UNUserNotificationCenter,
    willPresent notification: UNNotification,
    withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
  ) {
    if let pushPlugin = pushPlugin {
      pushPlugin.userNotificationCenter(center, willPresent: notification, withCompletionHandler: completionHandler)
    } else {
      completionHandler([])
    }
  }

  override func userNotificationCenter(
    _ center: UNUserNotificationCenter,
    didReceive response: UNNotificationResponse,
    withCompletionHandler completionHandler: @escaping () -> Void
  ) {
    if let pushPlugin = pushPlugin {
      pushPlugin.userNotificationCenter(center, didReceive: response, withCompletionHandler: completionHandler)
    } else {
      // Plugin not yet initialized (cold start). Cache the payload
      // so it can be handed to the plugin once it's ready.
      let userInfo = response.notification.request.content.userInfo
      if let wettyChatData = userInfo["wettyChat"] as? [String: Any] {
        pendingNotificationPayload = wettyChatData
      }
      completionHandler()
    }
  }
}
