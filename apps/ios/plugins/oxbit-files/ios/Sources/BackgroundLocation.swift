import CoreLocation
import Foundation
import Tauri

struct BackgroundLocationArgs: Decodable {
  let enabled: Bool
}

struct BackgroundLocationResult: Encodable {
  let active: Bool
  let authorization: String
}

/// Runs coarse location updates while a connection or agent turn needs the app awake, so iOS
/// keeps sockets open in the background. Locations stay on the device and are dropped on arrival.
final class BackgroundLocation: NSObject, CLLocationManagerDelegate {
  private var manager: CLLocationManager?
  private var session: AnyObject?
  private var waiting: [Invoke] = []
  private var active = false

  func handle(_ invoke: Invoke) {
    let args: BackgroundLocationArgs
    do {
      args = try invoke.parseArgs(BackgroundLocationArgs.self)
    } catch {
      invoke.reject(error.localizedDescription, code: "INVALID_ARGS")
      return
    }
    DispatchQueue.main.async {
      if args.enabled {
        self.enable(invoke)
      } else {
        self.stop()
        invoke.resolve(self.result())
      }
    }
  }

  private func locationManager() -> CLLocationManager {
    if let manager { return manager }
    let manager = CLLocationManager()
    manager.delegate = self
    manager.desiredAccuracy = kCLLocationAccuracyThreeKilometers
    manager.distanceFilter = CLLocationDistanceMax
    manager.pausesLocationUpdatesAutomatically = false
    self.manager = manager
    return manager
  }

  private func enable(_ invoke: Invoke) {
    let manager = locationManager()
    switch manager.authorizationStatus {
    case .notDetermined:
      waiting.append(invoke)
      if waiting.count == 1 { manager.requestWhenInUseAuthorization() }
    case .authorizedWhenInUse, .authorizedAlways:
      start()
      invoke.resolve(result())
    default:
      stop()
      invoke.resolve(result())
    }
  }

  private func start() {
    guard !active, let manager else { return }
    manager.allowsBackgroundLocationUpdates = true
    manager.showsBackgroundLocationIndicator = true
    manager.startUpdatingLocation()
    if #available(iOS 17.0, *) { session = CLBackgroundActivitySession() }
    active = true
  }

  private func stop() {
    guard active, let manager else { return }
    manager.stopUpdatingLocation()
    manager.allowsBackgroundLocationUpdates = false
    if #available(iOS 17.0, *) { (session as? CLBackgroundActivitySession)?.invalidate() }
    session = nil
    active = false
  }

  private func result() -> BackgroundLocationResult {
    let authorization: String
    switch manager?.authorizationStatus ?? .notDetermined {
    case .authorizedWhenInUse, .authorizedAlways: authorization = "granted"
    case .notDetermined: authorization = "prompt"
    default: authorization = "denied"
    }
    return BackgroundLocationResult(active: active, authorization: authorization)
  }

  func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
    if manager.authorizationStatus == .notDetermined { return }
    let pending = waiting
    waiting = []
    if pending.isEmpty {
      if manager.authorizationStatus != .authorizedWhenInUse && manager.authorizationStatus != .authorizedAlways { stop() }
      return
    }
    for invoke in pending { enable(invoke) }
  }

  func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {}

  func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {}
}
