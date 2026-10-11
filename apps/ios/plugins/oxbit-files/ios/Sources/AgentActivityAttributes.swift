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

    private enum CodingKeys: String, CodingKey {
      case status, title, detail, pending, startedAt
    }

    /// `startedAt` is Unix epoch seconds, the format runtime pushes send in `content-state`.
    public init(from decoder: Decoder) throws {
      let container = try decoder.container(keyedBy: CodingKeys.self)
      status = try container.decode(Status.self, forKey: .status)
      title = try container.decode(String.self, forKey: .title)
      detail = try container.decode(String.self, forKey: .detail)
      pending = try container.decode(Int.self, forKey: .pending)
      startedAt = try container.decodeIfPresent(Double.self, forKey: .startedAt).map(Date.init(timeIntervalSince1970:))
    }

    public func encode(to encoder: Encoder) throws {
      var container = encoder.container(keyedBy: CodingKeys.self)
      try container.encode(status, forKey: .status)
      try container.encode(title, forKey: .title)
      try container.encode(detail, forKey: .detail)
      try container.encode(pending, forKey: .pending)
      try container.encodeIfPresent(startedAt?.timeIntervalSince1970, forKey: .startedAt)
    }
  }

  public var agent: String

  public init(agent: String) {
    self.agent = agent
  }
}
