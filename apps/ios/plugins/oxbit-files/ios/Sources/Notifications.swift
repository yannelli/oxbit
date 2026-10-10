import Foundation
import Tauri
import UserNotifications

struct NotifyArgs: Decodable {
  let title: String
  let body: String?
  let tag: String?
}

struct WatchNotificationTapsArgs: Decodable {
  let channel: Channel
}

struct UnwatchNotificationTapsArgs: Decodable {
  let id: UInt64
}

struct NotificationPermissionResult: Encodable {
  let permission: String
}

/// Posts the agent panel's system notifications and reports taps on them. A tap that launches
/// Oxbit arrives before the WebView listens, so it waits until a channel subscribes.
final class Notifications: NSObject, UNUserNotificationCenterDelegate {
  private var channel: Channel?
  private var tapped = false

  override init() {
    super.init()
    // iOS delivers the launching tap only to a delegate set before launch finishes.
    UNUserNotificationCenter.current().delegate = self
  }

  func permission(_ invoke: Invoke) {
    UNUserNotificationCenter.current().getNotificationSettings { settings in
      invoke.resolve(NotificationPermissionResult(permission: Notifications.permission(settings.authorizationStatus)))
    }
  }

  func requestPermission(_ invoke: Invoke) {
    let center = UNUserNotificationCenter.current()
    center.requestAuthorization(options: [.alert, .sound]) { _, _ in
      center.getNotificationSettings { settings in
        invoke.resolve(NotificationPermissionResult(permission: Notifications.permission(settings.authorizationStatus)))
      }
    }
  }

  func notify(_ invoke: Invoke) {
    let args: NotifyArgs
    do {
      args = try invoke.parseArgs(NotifyArgs.self)
    } catch {
      invoke.reject(error.localizedDescription, code: "INVALID_ARGS")
      return
    }
    let content = UNMutableNotificationContent()
    content.title = args.title
    content.body = args.body ?? ""
    // A tag replaces the earlier notification with the same tag, as Web Notification does.
    let request = UNNotificationRequest(identifier: args.tag ?? UUID().uuidString, content: content, trigger: nil)
    UNUserNotificationCenter.current().add(request) { error in
      if let error {
        invoke.reject(error.localizedDescription, code: "NOTIFICATION")
      } else {
        invoke.resolve()
      }
    }
  }

  func watchTaps(_ invoke: Invoke) {
    let args: WatchNotificationTapsArgs
    do {
      args = try invoke.parseArgs(WatchNotificationTapsArgs.self)
    } catch {
      invoke.reject(error.localizedDescription, code: "INVALID_ARGS")
      return
    }
    DispatchQueue.main.async {
      self.channel = args.channel
      if self.tapped {
        self.tapped = false
        args.channel.send([:])
      }
      invoke.resolve()
    }
  }

  func unwatchTaps(_ invoke: Invoke) {
    let args: UnwatchNotificationTapsArgs
    do {
      args = try invoke.parseArgs(UnwatchNotificationTapsArgs.self)
    } catch {
      invoke.reject(error.localizedDescription, code: "INVALID_ARGS")
      return
    }
    DispatchQueue.main.async {
      if self.channel?.id == args.id { self.channel = nil }
      invoke.resolve()
    }
  }

  func userNotificationCenter(
    _ center: UNUserNotificationCenter,
    willPresent notification: UNNotification,
    withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
  ) {
    completionHandler([.banner, .list])
  }

  func userNotificationCenter(
    _ center: UNUserNotificationCenter,
    didReceive response: UNNotificationResponse,
    withCompletionHandler completionHandler: @escaping () -> Void
  ) {
    if response.actionIdentifier == UNNotificationDefaultActionIdentifier {
      DispatchQueue.main.async {
        if let channel = self.channel {
          channel.send([:])
        } else {
          self.tapped = true
        }
      }
    }
    completionHandler()
  }

  private static func permission(_ status: UNAuthorizationStatus) -> String {
    switch status {
    case .authorized, .provisional, .ephemeral: return "granted"
    case .denied: return "denied"
    default: return "default"
    }
  }
}
