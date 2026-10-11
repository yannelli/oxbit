import Foundation
import ObjectiveC
import Tauri
import UIKit

struct RemoteNotificationRegistration: Encodable {
  let token: String
  let environment: String
}

/// Registers with APNs. The plugin initializes before UIApplicationMain creates the app delegate,
/// so the APNs callbacks join the delegate's class when the first registration starts.
final class RemoteNotifications {
  private typealias TokenIMP = @convention(c) (AnyObject, Selector, UIApplication, NSData) -> Void
  private typealias ErrorIMP = @convention(c) (AnyObject, Selector, UIApplication, NSError) -> Void

  private var pending: [Invoke] = []
  private var installed = false

  func register(_ invoke: Invoke) {
    DispatchQueue.main.async {
      if !self.installed {
        guard let delegate = UIApplication.shared.delegate, let type = object_getClass(delegate) else {
          invoke.reject("The app delegate is not available yet", code: "NO_DELEGATE")
          return
        }
        self.install(on: type)
        self.installed = true
      }
      self.pending.append(invoke)
      UIApplication.shared.registerForRemoteNotifications()
    }
  }

  /// Adds the two delegate methods, calling the class's own implementation first when it has one.
  private func install(on type: AnyClass) {
    let tokenSelector = NSSelectorFromString("application:didRegisterForRemoteNotificationsWithDeviceToken:")
    let tokenOriginal = class_getInstanceMethod(type, tokenSelector).map {
      unsafeBitCast(method_getImplementation($0), to: TokenIMP.self)
    }
    let token: @convention(block) (AnyObject, UIApplication, NSData) -> Void = { [weak self] delegate, application, token in
      tokenOriginal?(delegate, tokenSelector, application, token)
      self?.finish(.success(token as Data))
    }
    class_replaceMethod(type, tokenSelector, imp_implementationWithBlock(token), "v@:@@")

    let errorSelector = NSSelectorFromString("application:didFailToRegisterForRemoteNotificationsWithError:")
    let errorOriginal = class_getInstanceMethod(type, errorSelector).map {
      unsafeBitCast(method_getImplementation($0), to: ErrorIMP.self)
    }
    let failure: @convention(block) (AnyObject, UIApplication, NSError) -> Void = { [weak self] delegate, application, error in
      errorOriginal?(delegate, errorSelector, application, error)
      self?.finish(.failure(error))
    }
    class_replaceMethod(type, errorSelector, imp_implementationWithBlock(failure), "v@:@@")
  }

  private func finish(_ result: Result<Data, Error>) {
    let invokes = pending
    pending.removeAll()
    switch result {
    case .success(let token):
      let registration = RemoteNotificationRegistration(
        token: token.map { String(format: "%02x", $0) }.joined(), environment: RemoteNotifications.environment())
      for invoke in invokes { invoke.resolve(registration) }
    case .failure(let error):
      for invoke in invokes { invoke.reject(error.localizedDescription, code: "REMOTE_NOTIFICATIONS") }
    }
  }

  /// Reads `aps-environment` from the embedded provisioning profile. App Store and TestFlight
  /// builds carry no profile and use the production APNs environment.
  static func environment() -> String {
    #if targetEnvironment(simulator)
      return "development"
    #else
      guard let url = Bundle.main.url(forResource: "embedded", withExtension: "mobileprovision"),
        let data = try? Data(contentsOf: url)
      else { return "production" }
      guard let text = String(data: data, encoding: .isoLatin1),
        let start = text.range(of: "<plist"),
        let end = text.range(of: "</plist>", range: start.upperBound..<text.endIndex),
        let xml = String(text[start.lowerBound..<end.upperBound]).data(using: .isoLatin1),
        let profile = try? PropertyListSerialization.propertyList(from: xml, format: nil) as? [String: Any],
        let entitlements = profile["Entitlements"] as? [String: Any],
        let environment = entitlements["aps-environment"] as? String
      else { return "development" }
      return environment
    #endif
  }
}
