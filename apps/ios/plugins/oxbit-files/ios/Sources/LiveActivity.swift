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

/// Shows the current agent turn as a Live Activity while Oxbit runs. Updates come only from the
/// app, so once iOS suspends it the activity keeps its last state until the stale date passes.
final class LiveActivity {
  private static let staleAfter: TimeInterval = 15 * 60

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
          try await LiveActivity.apply(update)
        } else {
          await LiveActivity.endAll()
        }
        invoke.resolve(LiveActivityResult(enabled: true))
      } catch {
        invoke.reject(error.localizedDescription, code: "LIVE_ACTIVITY")
      }
    }
  }

  /// Finds or requests the activity before the first suspension so two quick updates for one
  /// agent cannot start two activities.
  @available(iOS 16.2, *)
  @MainActor
  private static func apply(_ update: LiveActivityUpdate) async throws {
    let now = Date()
    let state = AgentActivityAttributes.ContentState(
      status: update.status,
      title: update.title,
      detail: update.detail,
      pending: update.pending,
      startedAt: update.startedAt.map { Date(timeIntervalSince1970: $0 / 1000) })
    let ending = update.status == .finished || update.status == .failed
    let content = ActivityContent(state: state, staleDate: ending ? nil : now.addingTimeInterval(staleAfter))
    if let activity = running(update.agent) {
      if ending {
        await activity.end(content, dismissalPolicy: .after(now.addingTimeInterval(staleAfter)))
      } else {
        await activity.update(content)
      }
      return
    }
    let activity = try Activity.request(
      attributes: AgentActivityAttributes(agent: update.agent), content: content, pushType: nil)
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
