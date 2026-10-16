import Foundation

final class StationUpdater {
    private let dataRoot: URL
    private let bundle: URL
    private let helper: URL
    private let config: URL
    private let lock = NSLock()
    private var snapshot: [String: Any]
    private var ready = false
    private let receiptID: String?

    init(dataRoot: URL, bundle: URL) {
        self.dataRoot = dataRoot
        self.bundle = bundle
        helper = bundle.appendingPathComponent("Contents/Helpers/StationUpdater")
        config = bundle.appendingPathComponent("Contents/Resources/app/update-config.json")
        let settings = (try? Data(contentsOf: config)).flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] }
        snapshot = ["available": false, "currentVersion": settings?["version"] as? String ?? "2.1.0", "platform": "macos", "message": "Updates have not been checked yet"]
        let args = CommandLine.arguments
        if let index = args.firstIndex(of: "--station-update-receipt"), index+1 < args.count { receiptID = args[index+1] } else { receiptID = nil }
    }

    var status: [String: Any] { lock.lock(); defer { lock.unlock() }; return snapshot }
    var canRestart: Bool { lock.lock(); defer { lock.unlock() }; return ready }

    private func arguments(_ command: String) -> [String] {
        [command, "--config", config.path, "--data", dataRoot.path]
    }

    private func command(_ name: String, extra: [String] = []) throws -> [String: Any] {
        let process = Process(); let pipe = Pipe()
        process.executableURL = helper; process.arguments = arguments(name) + extra
        process.standardOutput = pipe; process.standardError = FileHandle.nullDevice
        try process.run()
        let data = pipe.fileHandleForReading.readDataToEndOfFile(); process.waitUntilExit()
        let result = (try? JSONSerialization.jsonObject(with: data) as? [String: Any]) ?? [:]
        if process.terminationStatus != 0 { throw NSError(domain: "StationUpdater", code: 1, userInfo: [NSLocalizedDescriptionKey: result["error"] as? String ?? "Could not check for updates. Try again later."]) }
        return result
    }

    func check(force: Bool) throws -> [String: Any] {
        let result = try command("check", extra: force ? ["--force"] : [])
        lock.lock(); snapshot = result; lock.unlock()
        return result
    }

    func loadCached() {
        guard let result = try? command("status") else { return }
        lock.lock(); snapshot = result; lock.unlock()
    }

    @discardableResult func startupReceipt(ready: Bool) -> Bool {
        guard let receiptID else { return true }
        do {
            _ = try command(ready ? "ack" : "boot", extra: ["--job", receiptID, "--target", bundle.path, "--parent", String(ProcessInfo.processInfo.processIdentifier)])
            return true
        } catch { return false }
    }

    func install(event: @escaping ([String: Any]) -> Void) throws {
        guard status["available"] as? Bool == true else { throw NSError(domain: "StationUpdater", code: 2, userInfo: [NSLocalizedDescriptionKey: "Check for a verified update first."]) }
        let directory = dataRoot.appendingPathComponent("Updates/runners/\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        let runner = directory.appendingPathComponent("StationUpdater")
        let settings = directory.appendingPathComponent("update-config.json")
        try FileManager.default.copyItem(at: helper, to: runner)
        try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: runner.path)
        try FileManager.default.copyItem(at: config, to: settings)
        let process = Process(); let pipe = Pipe()
        process.executableURL = runner
        process.arguments = ["install", "--config", settings.path, "--data", dataRoot.path, "--target", bundle.path, "--parent", String(ProcessInfo.processInfo.processIdentifier)]
        process.standardOutput = pipe; process.standardError = FileHandle.nullDevice
        try process.run()
        var pending = Data(); var errorMessage: String?
        while true {
            let bytes = pipe.fileHandleForReading.availableData
            if bytes.isEmpty { break }
            pending.append(bytes)
            while let newline = pending.firstIndex(of: 10) {
                let line = Data(pending[..<newline]); pending.removeSubrange(...newline)
                guard let value = try? JSONSerialization.jsonObject(with: line) as? [String: Any] else { continue }
                if let error = value["error"] as? String { errorMessage = error }
                if value["phase"] as? String == "ready" { lock.lock(); ready = true; lock.unlock() }
                event(value)
            }
        }
        // The helper closes its pipe once staged, then outlives this app to replace it.
        if canRestart { return }
        process.waitUntilExit()
        if process.terminationStatus != 0 { throw NSError(domain: "StationUpdater", code: 3, userInfo: [NSLocalizedDescriptionKey: errorMessage ?? "The update could not be prepared. Original application kept."]) }
    }
}
