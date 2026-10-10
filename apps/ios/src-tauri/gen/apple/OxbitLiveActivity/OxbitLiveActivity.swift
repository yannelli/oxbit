import ActivityKit
import SwiftUI
import WidgetKit

@main
struct OxbitLiveActivityBundle: WidgetBundle {
  var body: some Widget {
    AgentActivityWidget()
  }
}

struct AgentActivityWidget: Widget {
  var body: some WidgetConfiguration {
    ActivityConfiguration(for: AgentActivityAttributes.self) { context in
      LockScreenView(agent: context.attributes.agent, state: context.state, stale: context.isStale)
    } dynamicIsland: { context in
      let state = context.state
      let stale = context.isStale
      return DynamicIsland {
        DynamicIslandExpandedRegion(.leading) {
          StatusGlyph(status: state.status, stale: stale)
            .font(.title2)
        }
        DynamicIslandExpandedRegion(.trailing) {
          Text(context.attributes.agent)
            .font(.caption)
            .foregroundStyle(.secondary)
            .lineLimit(1)
        }
        DynamicIslandExpandedRegion(.center) {
          Text(state.title)
            .font(.headline)
            .lineLimit(1)
        }
        DynamicIslandExpandedRegion(.bottom) {
          VStack(alignment: .leading, spacing: 2) {
            StatusLine(state: state, stale: stale)
              .font(.subheadline)
            DetailLine(detail: state.detail)
          }
          .frame(maxWidth: .infinity, alignment: .leading)
        }
      } compactLeading: {
        Image(systemName: "chevron.left.forwardslash.chevron.right")
          .foregroundStyle(stale ? .secondary : state.status.tint)
      } compactTrailing: {
        CompactTrailing(state: state, stale: stale)
      } minimal: {
        StatusGlyph(status: state.status, stale: stale)
      }
      .keylineTint(state.status.tint)
    }
  }
}

struct LockScreenView: View {
  let agent: String
  let state: AgentActivityAttributes.ContentState
  let stale: Bool

  var body: some View {
    HStack(alignment: .top, spacing: 12) {
      StatusGlyph(status: state.status, stale: stale)
        .font(.title2)
      VStack(alignment: .leading, spacing: 2) {
        Text(agent)
          .font(.caption)
          .foregroundStyle(.secondary)
          .lineLimit(1)
        Text(state.title)
          .font(.headline)
          .lineLimit(1)
        StatusLine(state: state, stale: stale)
          .font(.subheadline)
        DetailLine(detail: state.detail)
      }
      Spacer(minLength: 0)
    }
    .padding(16)
  }
}

struct StatusLine: View {
  let state: AgentActivityAttributes.ContentState
  let stale: Bool

  var body: some View {
    if stale {
      Text("Open Oxbit to refresh")
        .foregroundStyle(.secondary)
    } else {
      switch state.status {
      case .working:
        HStack(spacing: 4) {
          Text("Working")
          if let startedAt = state.startedAt {
            Text(startedAt, style: .timer)
              .monospacedDigit()
          }
        }
        .foregroundStyle(state.status.tint)
      case .waiting:
        Text(state.pending > 0 ? "Needs input · \(state.pending)" : "Needs input")
          .foregroundStyle(state.status.tint)
      case .finished:
        Text("Finished")
          .foregroundStyle(state.status.tint)
      case .failed:
        Text("Failed")
          .foregroundStyle(state.status.tint)
      }
    }
  }
}

struct DetailLine: View {
  let detail: String

  var body: some View {
    if !detail.isEmpty {
      Text(detail)
        .font(.caption)
        .foregroundStyle(.secondary)
        .lineLimit(1)
    }
  }
}

struct CompactTrailing: View {
  let state: AgentActivityAttributes.ContentState
  let stale: Bool

  var body: some View {
    if !stale, state.status == .working, let startedAt = state.startedAt {
      Text(startedAt, style: .timer)
        .monospacedDigit()
        .multilineTextAlignment(.trailing)
        .frame(maxWidth: 52)
        .foregroundStyle(state.status.tint)
    } else {
      StatusGlyph(status: state.status, stale: stale)
    }
  }
}

struct StatusGlyph: View {
  let status: AgentActivityAttributes.Status
  let stale: Bool

  var body: some View {
    Image(systemName: stale ? "clock.arrow.circlepath" : status.symbol)
      .foregroundStyle(stale ? .secondary : status.tint)
  }
}

extension AgentActivityAttributes.Status {
  var symbol: String {
    switch self {
    case .working: "sparkles"
    case .waiting: "hand.raised.fill"
    case .finished: "checkmark.circle.fill"
    case .failed: "xmark.octagon.fill"
    }
  }

  var tint: Color {
    switch self {
    case .working: .cyan
    case .waiting: .orange
    case .finished: .green
    case .failed: .red
    }
  }
}
