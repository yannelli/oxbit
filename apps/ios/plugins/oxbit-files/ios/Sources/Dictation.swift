import AVFoundation
import Foundation
import Speech
import Tauri

struct StartDictationArgs: Decodable {
  let channel: Channel
  let lang: String?
}

struct StopDictationArgs: Decodable {
  let abort: Bool?
}

enum DictationError: LocalizedError {
  case noMicrophone
  var errorDescription: String? { "No microphone input is available" }
}

/// Streams Apple speech recognition to the web view's `SpeechRecognition` polyfill as channel
/// events. One session runs at a time; a new start aborts the previous one. State changes run on main.
final class Dictation {
  private final class Session {
    let channel: Channel
    var recognizer: SFSpeechRecognizer?
    var request: SFSpeechAudioBufferRecognitionRequest?
    var task: SFSpeechRecognitionTask?
    var engine: AVAudioEngine?
    var audioActive = false
    var stopping = false

    init(channel: Channel) {
      self.channel = channel
    }
  }

  private static let stopTimeout: TimeInterval = 10
  private var session: Session?

  func start(_ invoke: Invoke) {
    let args: StartDictationArgs
    do {
      args = try invoke.parseArgs(StartDictationArgs.self)
    } catch {
      invoke.reject(error.localizedDescription, code: "INVALID_ARGS")
      return
    }
    invoke.resolve()
    DispatchQueue.main.async {
      if let current = self.session {
        self.fail(current, "aborted", "Another dictation session started")
      }
      let session = Session(channel: args.channel)
      self.session = session
      let language = args.lang ?? ""
      let locale = language.isEmpty ? Locale.current : Locale(identifier: language)
      guard let recognizer = SFSpeechRecognizer(locale: locale) else {
        self.fail(session, "language-not-supported", "Speech recognition does not support \(locale.identifier)")
        return
      }
      session.recognizer = recognizer
      self.authorize(session)
    }
  }

  func stop(_ invoke: Invoke) {
    let abort = (try? invoke.parseArgs(StopDictationArgs.self))?.abort ?? false
    invoke.resolve()
    DispatchQueue.main.async {
      guard let session = self.session else { return }
      guard !abort, session.task != nil else {
        self.finish(session)
        return
      }
      session.stopping = true
      self.stopAudio(session)
      session.request?.endAudio()
      DispatchQueue.main.asyncAfter(deadline: .now() + Dictation.stopTimeout) {
        self.finish(session)
      }
    }
  }

  private func authorize(_ session: Session) {
    SFSpeechRecognizer.requestAuthorization { status in
      DispatchQueue.main.async {
        guard self.session === session else { return }
        guard status == .authorized else {
          self.fail(session, "service-not-allowed", "Speech recognition is not allowed")
          return
        }
        self.requestMicrophone { granted in
          DispatchQueue.main.async {
            guard self.session === session else { return }
            guard granted else {
              self.fail(session, "not-allowed", "Microphone access is not allowed")
              return
            }
            self.begin(session)
          }
        }
      }
    }
  }

  private func requestMicrophone(_ completion: @escaping (Bool) -> Void) {
    if #available(iOS 17.0, *) {
      AVAudioApplication.requestRecordPermission(completionHandler: completion)
    } else {
      AVAudioSession.sharedInstance().requestRecordPermission(completion)
    }
  }

  private func begin(_ session: Session) {
    guard let recognizer = session.recognizer, recognizer.isAvailable else {
      fail(session, "language-not-supported", "Speech recognition is unavailable")
      return
    }
    let request = SFSpeechAudioBufferRecognitionRequest()
    request.shouldReportPartialResults = true
    if recognizer.supportsOnDeviceRecognition {
      request.requiresOnDeviceRecognition = true
    }
    let engine = AVAudioEngine()
    session.request = request
    do {
      let audio = AVAudioSession.sharedInstance()
      try audio.setCategory(.record, mode: .measurement, options: .duckOthers)
      try audio.setActive(true, options: .notifyOthersOnDeactivation)
      session.audioActive = true
      let input = engine.inputNode
      let format = input.outputFormat(forBus: 0)
      guard format.sampleRate > 0, format.channelCount > 0 else { throw DictationError.noMicrophone }
      input.installTap(onBus: 0, bufferSize: 1024, format: format) { buffer, _ in
        request.append(buffer)
      }
      session.engine = engine
      engine.prepare()
      try engine.start()
    } catch {
      fail(session, "audio-capture", error.localizedDescription)
      return
    }
    session.task = recognizer.recognitionTask(with: request) { [weak self, weak session] result, error in
      DispatchQueue.main.async {
        guard let self, let session else { return }
        self.receive(session, result: result, error: error)
      }
    }
    emit(session, ["type": "start"])
  }

  private func receive(_ session: Session, result: SFSpeechRecognitionResult?, error: Error?) {
    guard self.session === session else { return }
    if let result {
      emit(session, ["type": "result", "text": result.bestTranscription.formattedString, "final": result.isFinal])
      if result.isFinal {
        finish(session)
        return
      }
    }
    guard let error else { return }
    let code = Dictation.code(for: error)
    if session.stopping && code == "no-speech" {
      finish(session)
    } else {
      fail(session, code, error.localizedDescription)
    }
  }

  private func fail(_ session: Session, _ code: String, _ message: String) {
    guard self.session === session else { return }
    emit(session, ["type": "error", "error": code, "message": message])
    finish(session)
  }

  private func finish(_ session: Session) {
    guard self.session === session else { return }
    self.session = nil
    stopAudio(session)
    session.request?.endAudio()
    session.task?.cancel()
    if session.audioActive {
      try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }
    emit(session, ["type": "end"])
  }

  private func stopAudio(_ session: Session) {
    guard let engine = session.engine else { return }
    session.engine = nil
    engine.stop()
    engine.inputNode.removeTap(onBus: 0)
  }

  private func emit(_ session: Session, _ payload: JsonObject) {
    session.channel.send(payload)
  }

  /// kAFAssistantErrorDomain has no public header; the codes follow Apple's
  /// SFSpeechRecognitionTask error table.
  private static func code(for error: Error) -> String {
    let error = error as NSError
    switch (error.domain, error.code) {
    case ("kAFAssistantErrorDomain", 203), ("kAFAssistantErrorDomain", 1110):
      return "no-speech"
    case ("kAFAssistantErrorDomain", 201), ("kAFAssistantErrorDomain", 1700):
      return "service-not-allowed"
    case ("kAFAssistantErrorDomain", 102), ("kAFAssistantErrorDomain", 300):
      return "language-not-supported"
    case ("kAFAssistantErrorDomain", 216), ("kAFAssistantErrorDomain", 301):
      return "aborted"
    case ("SFSpeechErrorDomain", 2):
      return "audio-capture"
    default:
      return "network"
    }
  }
}
