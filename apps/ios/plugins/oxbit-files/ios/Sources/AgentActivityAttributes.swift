import ActivityKit
import Foundation

/// Shared by the plugin and the OxbitLiveActivity widget extension. ActivityKit pairs the app's
/// activity with the extension's ActivityConfiguration by this type's name.
@available(iOS 16.1, *)
public struct AgentActivityAttributes: ActivityAttributes {
  public enum Status: String, Codable, Hashable {
    case working
    case waiting
    case finished
    case failed
  }

  public struct ContentState: Codable, Hashable {
    public var status: Status
    public var title: String
    public var detail: String
    public var pending: Int
    public var startedAt: Date?

    public init(status: Status, title: String, detail: String, pending: Int, startedAt: Date?) {
      self.status = status
      self.title = title
      self.detail = detail
      self.pending = pending
      self.startedAt = startedAt
    }
  }

  public var agent: String

  public init(agent: String) {
    self.agent = agent
  }
}
