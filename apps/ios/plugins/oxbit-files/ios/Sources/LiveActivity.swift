import ActivityKit
import Foundation
import Tauri

@available(iOS 16.2, *)
struct LiveActivityArgs: Decodable {
  let update: LiveActivityUpdate?
}

@available(iOS 16.2, *)
struct LiveActivityUpdate: Decodable {
  let agent: String
  let title: String
  let status: AgentActivityAttributes.Status
  let detail: String
  let pending: Int
  let startedAt: Double?
}

struct LiveActivityResult: Encodable {
  let enabled: Bool
}

struct WatchLiveActivityTokensArgs: Decodable {
  let channel: Channel
}

struct UnwatchLiveActivityTokensArgs: Decodable {
  let id: UInt64
}

/// Shows the current agent turn as a Live Activity. The app updates it while it runs; a runtime
/// updates it through the activity's push token once iOS suspends the app.
final class LiveActivity {
  private static let staleAfter: TimeInterval = 15 * 60
  private var channel: Channel?
  private var token: String?
  private var observed = Set<String>()

  func handle(_ invoke: Invoke) {
    guard #available(iOS 16.2, *) else {
      invoke.resolve(LiveActivityResult(enabled: false))
      return
    }
    let args: LiveActivityArgs
    do {
      args = try invoke.parseArgs(LiveActivityArgs.self)
    } catch {
      invoke.reject(error.localizedDescription, code: "INVALID_ARGS")
      return
    }
    Task { @MainActor in
      guard ActivityAuthorizationInfo().areActivitiesEnabled else {
        invoke.resolve(LiveActivityResult(enabled: false))
        return
      }
      do {
        if let update = args.update {
          try await self.apply(update)
        } else {
          await LiveActivity.endAll()
        }
        invoke.resolve(LiveActivityResult(enabled: true))
      } catch {
        invoke.reject(error.localizedDescription, code: "LIVE_ACTIVITY")
      }
    }
  }

  /// Reports each activity's push token in hex. A new channel receives the latest token first.
  func watchTokens(_ invoke: Invoke) {
    let args: WatchLiveActivityTokensArgs
    do {
      args = try invoke.parseArgs(WatchLiveActivityTokensArgs.self)
    } catch {
      invoke.reject(error.localizedDescription, code: "INVALID_ARGS")
      return
    }
    Task { @MainActor in
      self.channel = args.channel
      if let token = self.token { args.channel.send(["token": token] as JsonObject) }
      if #available(iOS 16.2, *) {
        for activity in Activity<AgentActivityAttributes>.activities { self.observe(activity) }
      }
      invoke.resolve()
    }
  }

  func unwatchTokens(_ invoke: Invoke) {
    let args: UnwatchLiveActivityTokensArgs
    do {
      args = try invoke.parseArgs(UnwatchLiveActivityTokensArgs.self)
    } catch {
      invoke.reject(error.localizedDescription, code: "INVALID_ARGS")
      return
    }
    Task { @MainActor in
      if self.channel?.id == args.id { self.channel = nil }
      invoke.resolve()
    }
  }

  @available(iOS 16.2, *)
  @MainActor
  private func observe(_ activity: Activity<AgentActivityAttributes>) {
    guard observed.insert(activity.id).inserted else { return }
    if let data = activity.pushToken { report(data) }
    Task { @MainActor in
      for await data in activity.pushTokenUpdates { self.report(data) }
      self.observed.remove(activity.id)
    }
  }

  @MainActor
  private func report(_ data: Data) {
    let token = data.map { String(format: "%02x", $0) }.joined()
    self.token = token
    channel?.send(["token": token] as JsonObject)
  }

  /// Finds or requests the activity before the first suspension so two quick updates for one
  /// agent cannot start two activities.
  @available(iOS 16.2, *)
  @MainActor
  private func apply(_ update: LiveActivityUpdate) async throws {
    let now = Date()
    let state = AgentActivityAttributes.ContentState(
      status: update.status,
      title: update.title,
      detail: update.detail,
      pending: update.pending,
      startedAt: update.startedAt.map { Date(timeIntervalSince1970: $0 / 1000) })
    let ending = update.status == .finished || update.status == .failed
    let staleAfter = LiveActivity.staleAfter
    let content = ActivityContent(state: state, staleDate: ending ? nil : now.addingTimeInterval(staleAfter))
    if let activity = LiveActivity.running(update.agent) {
      if ending {
        await activity.end(content, dismissalPolicy: .after(now.addingTimeInterval(staleAfter)))
      } else {
        await activity.update(content)
      }
      return
    }
    let attributes = AgentActivityAttributes(agent: update.agent)
    let activity: Activity<AgentActivityAttributes>
    do {
      activity = try Activity.request(attributes: attributes, content: content, pushType: .token)
      observe(activity)
    } catch {
      // Keeps local updates when iOS refuses a push token, as without the aps-environment entitlement.
      activity = try Activity.request(attributes: attributes, content: content, pushType: nil)
    }
    if ending {
      await activity.end(content, dismissalPolicy: .after(now.addingTimeInterval(staleAfter)))
    }
  }

  @available(iOS 16.2, *)
  @MainActor
  private static func endAll() async {
    for activity in Activity<AgentActivityAttributes>.activities {
      await activity.end(nil, dismissalPolicy: .immediate)
    }
  }

  @available(iOS 16.2, *)
  @MainActor
  private static func running(_ agent: String) -> Activity<AgentActivityAttributes>? {
    Activity<AgentActivityAttributes>.activities.first {
      $0.attributes.agent == agent && ($0.activityState == .active || $0.activityState == .stale)
    }
  }
}
