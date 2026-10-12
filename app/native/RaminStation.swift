import AppKit
import CryptoKit
import UniformTypeIdentifiers
import WebKit

final class WindowDragView: NSView {
    override var mouseDownCanMoveWindow: Bool { true }

    override func mouseDown(with event: NSEvent) {
        window?.performDrag(with: event)
    }
}

@main
final class RaminStationApp: NSObject, NSApplicationDelegate, WKScriptMessageHandler, WKNavigationDelegate {
    private var window: NSWindow!
    private var webView: WKWebView!
    private var windowDragView: WindowDragView!
    private let fileManager = FileManager.default
    private let processLock = NSLock()
    private var currentProcess: Process?
    private var cancelRequested = false

    private lazy var managedBinDirectory: URL = {
        if let override = ProcessInfo.processInfo.environment["RAMIN_STATION_BIN"], !override.isEmpty {
            return URL(fileURLWithPath: override, isDirectory: true)
        }
        let applicationSupport = fileManager.urls(for: .applicationSupportDirectory, in: .userDomainMask).first!
        return applicationSupport.appendingPathComponent("Ramin Station/bin", isDirectory: true)
    }()

    private lazy var visualBrainStateURL: URL = {
        let applicationSupport = fileManager.urls(for: .applicationSupportDirectory, in: .userDomainMask).first!
        return applicationSupport.appendingPathComponent("Ramin Station/visual-brain.json", isDirectory: false)
    }()

    private lazy var visualBrainMediaDirectory: URL = {
        let applicationSupport = fileManager.urls(for: .applicationSupportDirectory, in: .userDomainMask).first!
        return applicationSupport.appendingPathComponent("Ramin Station/Visual Brain Files", isDirectory: true)
    }()

    static func main() {
        let application = NSApplication.shared
        let delegate = RaminStationApp()
        application.delegate = delegate
        application.setActivationPolicy(.regular)
        application.run()
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        configureMenus()
        let controller = WKUserContentController()
        controller.add(self, name: "raminStation")

        let configuration = WKWebViewConfiguration()
        configuration.userContentController = controller
        configuration.websiteDataStore = .default()
        configuration.mediaTypesRequiringUserActionForPlayback = []

        webView = WKWebView(frame: .zero, configuration: configuration)
        webView.navigationDelegate = self
        webView.setValue(false, forKey: "drawsBackground")

        window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 1269, height: 794),
            styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
            backing: .buffered,
            defer: false
        )
        window.title = "Ramin Station"
        window.titleVisibility = .hidden
        window.titlebarAppearsTransparent = true
        window.isMovableByWindowBackground = true
        window.backgroundColor = .black
        window.minSize = NSSize(width: 960, height: 601)
        window.aspectRatio = NSSize(width: 1586, height: 992)
        let contentView = NSView(frame: NSRect(x: 0, y: 0, width: 1269, height: 794))
        webView.frame = contentView.bounds
        webView.autoresizingMask = [.width, .height]
        contentView.addSubview(webView)
        windowDragView = WindowDragView(frame: NSRect(x: 0, y: contentView.bounds.height - 24, width: contentView.bounds.width, height: 24))
        windowDragView.autoresizingMask = [.width, .minYMargin]
        windowDragView.wantsLayer = true
        windowDragView.layer?.backgroundColor = NSColor.clear.cgColor
        contentView.addSubview(windowDragView, positioned: .above, relativeTo: webView)
        window.contentView = contentView
        window.center()
        window.makeKeyAndOrderFront(nil)
        window.standardWindowButton(.closeButton)?.isHidden = true
        window.standardWindowButton(.miniaturizeButton)?.isHidden = true
        window.standardWindowButton(.zoomButton)?.isHidden = true

        guard let resources = Bundle.main.resourceURL?.appendingPathComponent("app"),
              fileManager.fileExists(atPath: resources.appendingPathComponent("index.html").path) else {
            showError("Application resources are missing.")
            return
        }
        webView.loadFileURL(resources.appendingPathComponent("index.html"), allowingReadAccessTo: resources)
        NSApp.activate(ignoringOtherApps: true)
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }

    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        if navigationAction.navigationType == .linkActivated,
           let url = navigationAction.request.url,
           ["http", "https"].contains(url.scheme?.lowercased() ?? "") {
            NSWorkspace.shared.open(url)
            decisionHandler(.cancel)
            return
        }
        decisionHandler(.allow)
    }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.name == "raminStation",
              let body = message.body as? [String: Any],
              let requestID = body["id"] as? Int,
              let action = body["action"] as? String else { return }
        let payload = body["payload"] as? [String: Any] ?? [:]

        if action == "chooseFolder" {
            chooseFolder(requestID: requestID)
            return
        }
        if action == "chooseFile" {
            chooseFile(requestID: requestID, kind: payload["kind"] as? String ?? "video")
            return
        }
        if action == "readClipboard" {
            respond(requestID, ["text": NSPasteboard.general.string(forType: .string) ?? ""])
            return
        }
        if action == "windowControl" {
            handleWindowControl(payload["control"] as? String ?? "")
            respond(requestID, ["ok": true])
            return
        }
        if action == "openExternal" {
            if let text = payload["url"] as? String,
               let url = URL(string: text),
               ["http", "https"].contains(url.scheme?.lowercased() ?? "") {
                NSWorkspace.shared.open(url)
            }
            respond(requestID, ["ok": true])
            return
        }
        if action == "visualBrainLoad" {
            loadVisualBrain(requestID: requestID)
            return
        }
        if action == "visualBrainSave" {
            saveVisualBrain(requestID: requestID, state: payload["state"])
            return
        }
        if action.hasPrefix("visualBrainImport") || action == "visualBrainRevealFile" || action == "visualBrainDeleteFile" {
            handleVisualBrainFileAction(requestID: requestID, action: action, payload: payload)
            return
        }
        if action == "cancel" {
            cancelCurrentJob()
            respond(requestID, ["message": "Cancelled"])
            return
        }

        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            guard let self else { return }
            do {
                let result: [String: Any]
                switch action {
                case "dependencies": result = self.dependencies(payload["tools"] as? [String])
                case "install": result = try self.installTools(payload)
                case "download": result = try self.download(payload)
                case "visualBrainDownload": result = try self.visualBrainDownload(payload)
                case "compress": result = try self.compress(payload)
                default: throw StationError("Unknown action.")
                }
                self.respond(requestID, result)
            } catch {
                self.respond(requestID, ["error": error.localizedDescription])
            }
        }
    }

    private func chooseFolder(requestID: Int) {
        let panel = NSOpenPanel()
        panel.title = "Choose a video folder"
        panel.prompt = "Choose Folder"
        panel.canChooseFiles = false
        panel.canChooseDirectories = true
        panel.allowsMultipleSelection = false
        panel.canCreateDirectories = true
        if panel.runModal() == .OK, let url = panel.url {
            respond(requestID, ["path": url.path])
        } else {
            respond(requestID, ["cancelled": true])
        }
    }

    private func chooseFile(requestID: Int, kind: String) {
        let panel = NSOpenPanel()
        panel.title = kind == "cookies" ? "Choose a Netscape cookies.txt file" : "Choose one video file"
        panel.prompt = "Choose File"
        panel.canChooseFiles = true
        panel.canChooseDirectories = false
        panel.allowsMultipleSelection = false
        let extensions = kind == "cookies" ? ["txt"] : ["mp4", "mov", "mkv", "avi", "m4v", "webm"]
        panel.allowedContentTypes = extensions.compactMap { UTType(filenameExtension: $0) }
        if panel.runModal() == .OK, let url = panel.url {
            respond(requestID, ["path": url.path])
        } else {
            respond(requestID, ["cancelled": true])
        }
    }

    private func configureMenus() {
        let mainMenu = NSMenu()
        let applicationItem = NSMenuItem()
        mainMenu.addItem(applicationItem)
        let applicationMenu = NSMenu()
        applicationMenu.addItem(withTitle: "Quit Ramin Station", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        applicationItem.submenu = applicationMenu

        let editItem = NSMenuItem(title: "Edit", action: nil, keyEquivalent: "")
        mainMenu.addItem(editItem)
        let editMenu = NSMenu(title: "Edit")
        editMenu.addItem(withTitle: "Cut", action: NSSelectorFromString("cut:"), keyEquivalent: "x")
        editMenu.addItem(withTitle: "Copy", action: NSSelectorFromString("copy:"), keyEquivalent: "c")
        editMenu.addItem(withTitle: "Paste", action: NSSelectorFromString("paste:"), keyEquivalent: "v")
        editMenu.addItem(NSMenuItem.separator())
        editMenu.addItem(withTitle: "Select All", action: NSSelectorFromString("selectAll:"), keyEquivalent: "a")
        editItem.submenu = editMenu
        NSApp.mainMenu = mainMenu
    }

    private func handleWindowControl(_ control: String) {
        switch control {
        case "close": window.performClose(nil)
        case "minimize": window.miniaturize(nil)
        case "zoom": window.toggleFullScreen(nil)
        case "drag":
            if let event = NSApp.currentEvent { window.performDrag(with: event) }
        default: break
        }
    }

    private func loadVisualBrain(requestID: Int) {
        do {
            guard fileManager.fileExists(atPath: visualBrainStateURL.path) else {
                respond(requestID, ["state": ["version": 1, "items": []]])
                return
            }
            let data = try Data(contentsOf: visualBrainStateURL)
            let object = try JSONSerialization.jsonObject(with: data)
            respond(requestID, ["state": object])
        } catch {
            respond(requestID, ["error": "Could not load Visual Brain: \(error.localizedDescription)"])
        }
    }

    private func saveVisualBrain(requestID: Int, state: Any?) {
        do {
            guard let state, JSONSerialization.isValidJSONObject(state) else {
                throw StationError("Visual Brain data is invalid.")
            }
            try fileManager.createDirectory(at: visualBrainStateURL.deletingLastPathComponent(), withIntermediateDirectories: true)
            let data = try JSONSerialization.data(withJSONObject: state, options: [.prettyPrinted, .sortedKeys])
            try data.write(to: visualBrainStateURL, options: .atomic)
            respond(requestID, ["ok": true])
        } catch {
            respond(requestID, ["error": "Could not save Visual Brain: \(error.localizedDescription)"])
        }
    }

    private func visualBrainItemDirectory(_ rawID: Any?) throws -> URL {
        guard let storageID = rawID as? String, UUID(uuidString: storageID) != nil else {
            throw StationError("Visual Brain file ID is invalid.")
        }
        let root = visualBrainMediaDirectory.standardizedFileURL
        let directory = root.appendingPathComponent(storageID, isDirectory: true).standardizedFileURL
        guard directory.path.hasPrefix(root.path + "/") else {
            throw StationError("Visual Brain file location is invalid.")
        }
        return directory
    }

    private func visualBrainStoredFile(in directory: URL) throws -> URL {
        let files = try fileManager.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil, options: [.skipsHiddenFiles])
        guard let file = files.first(where: {
            !$0.hasDirectoryPath && !$0.lastPathComponent.hasSuffix(".part") && !$0.lastPathComponent.hasSuffix(".ytdl")
        }) else {
            throw StationError("The managed Visual Brain file is missing.")
        }
        return file
    }

    private func safeVisualBrainFilename(_ rawName: String) -> String {
        let lastComponent = URL(fileURLWithPath: rawName).lastPathComponent
        let sanitized = lastComponent.replacingOccurrences(of: ":", with: "_").replacingOccurrences(of: "/", with: "_")
        return sanitized.isEmpty || sanitized == "." ? "Untitled Media" : String(sanitized.prefix(180))
    }

    private func handleVisualBrainFileAction(requestID: Int, action: String, payload: [String: Any]) {
        do {
            let directory = try visualBrainItemDirectory(payload["storageID"])
            switch action {
            case "visualBrainImportStart":
                try fileManager.createDirectory(at: visualBrainMediaDirectory, withIntermediateDirectories: true)
                if fileManager.fileExists(atPath: directory.path) { try fileManager.removeItem(at: directory) }
                try fileManager.createDirectory(at: directory, withIntermediateDirectories: true)
                let filename = safeVisualBrainFilename(payload["name"] as? String ?? "Untitled Media")
                let destination = directory.appendingPathComponent(filename, isDirectory: false)
                guard fileManager.createFile(atPath: destination.path, contents: Data()) else {
                    throw StationError("Could not create the managed media copy.")
                }
                respond(requestID, ["ok": true, "storageID": payload["storageID"] as? String ?? ""])
            case "visualBrainImportChunk":
                guard let encoded = payload["data"] as? String, let data = Data(base64Encoded: encoded) else {
                    throw StationError("The media copy chunk is invalid.")
                }
                let destination = try visualBrainStoredFile(in: directory)
                let handle = try FileHandle(forWritingTo: destination)
                handle.seekToEndOfFile()
                handle.write(data)
                try handle.close()
                respond(requestID, ["ok": true])
            case "visualBrainImportFinish":
                let destination = try visualBrainStoredFile(in: directory)
                respond(requestID, ["ok": true, "name": destination.lastPathComponent])
            case "visualBrainImportAbort", "visualBrainDeleteFile":
                if fileManager.fileExists(atPath: directory.path) { try fileManager.removeItem(at: directory) }
                respond(requestID, ["ok": true])
            case "visualBrainRevealFile":
                let destination = try visualBrainStoredFile(in: directory)
                NSWorkspace.shared.activateFileViewerSelecting([destination])
                respond(requestID, ["ok": true])
            default:
                throw StationError("Unknown Visual Brain file action.")
            }
        } catch {
            respond(requestID, ["error": error.localizedDescription])
        }
    }

    private func cancelCurrentJob() {
        processLock.lock()
        cancelRequested = true
        let process = currentProcess
        processLock.unlock()
        if process?.isRunning == true { process?.terminate() }
        emitEvent(message: "Process cancelled by user.", progress: nil)
    }

    private func dependencies(_ requested: [String]? = nil) -> [String: Any] {
        let tools = Set(requested ?? ["ffmpeg", "ytdlp", "deno"])
        var result: [String: Any] = [:]
        if tools.contains("ffmpeg") { result["ffmpeg"] = commandInfo("ffmpeg", arguments: ["-version"]) }
        if tools.contains("ytdlp") { result["ytdlp"] = commandInfo("yt-dlp", arguments: ["--version"]) }
        if tools.contains("deno") { result["deno"] = commandInfo("deno", arguments: ["--version"]) }
        return result
    }

    private func commandInfo(_ command: String, arguments: [String]) -> [String: Any] {
        guard let executable = findExecutable(command) else { return ["ready": false, "version": "missing"] }
        if executable.hasPrefix(managedBinDirectory.path + "/") {
            return ["ready": true, "version": "managed • ready"]
        }
        do {
            let result = try run(executable, arguments)
            let line = result.output.split(separator: "\n").first.map(String.init) ?? "ready"
            return ["ready": result.status == 0, "version": String(line.prefix(42))]
        } catch {
            return ["ready": false, "version": "missing"]
        }
    }

    private func installTools(_ payload: [String: Any]) throws -> [String: Any] {
        let requested = Set(payload["tools"] as? [String] ?? [])
        try fileManager.createDirectory(at: managedBinDirectory, withIntermediateDirectories: true)

        if requested.contains("ffmpeg") && findExecutable("ffmpeg") == nil {
            emitEvent(message: "Installing verified FFmpeg package…", progress: nil)
            try installFFmpeg()
        }
        if requested.contains("deno") && findExecutable("deno") == nil {
            emitEvent(message: "Installing verified Deno runtime…", progress: nil)
            try installDeno()
        }
        if requested.contains("ytdlp") {
            emitEvent(message: "Installing the latest verified yt-dlp…", progress: nil)
            try installYTDLP()
        }

        let result = dependencies(Array(requested))
        for tool in requested {
            if let info = result[tool] as? [String: Any], info["ready"] as? Bool != true {
                throw StationError("Could not finish installing \(tool). Check your internet connection and try again.")
            }
        }
        emitEvent(message: "Setup complete — media tools are ready.", progress: nil)
        return result
    }

    private func installYTDLP() throws {
        let assetName = "yt-dlp_macos"
        let base = "https://github.com/yt-dlp/yt-dlp/releases/latest/download"
        let sums = try fetchText(URL(string: "\(base)/SHA2-256SUMS")!)
        guard let expected = checksum(named: assetName, in: sums) else {
            throw StationError("Could not verify the yt-dlp release manifest.")
        }
        try installExecutable(from: URL(string: "\(base)/\(assetName)")!, named: "yt-dlp", expectedSHA256: expected)
    }

    private func installDeno() throws {
        #if arch(arm64)
        let assetName = "deno-aarch64-apple-darwin.zip"
        #else
        let assetName = "deno-x86_64-apple-darwin.zip"
        #endif
        let base = "https://github.com/denoland/deno/releases/latest/download"
        let archiveURL = URL(string: "\(base)/\(assetName)")!
        let expected = try fetchText(URL(string: "\(base)/\(assetName).sha256sum")!)
            .split(whereSeparator: { $0.isWhitespace }).first.map(String.init) ?? ""
        guard expected.count == 64 else { throw StationError("Could not verify the Deno release manifest.") }

        let temporary = fileManager.temporaryDirectory.appendingPathComponent("RaminStation-\(UUID().uuidString)", isDirectory: true)
        defer { try? fileManager.removeItem(at: temporary) }
        try fileManager.createDirectory(at: temporary, withIntermediateDirectories: true)
        let archive = temporary.appendingPathComponent(assetName)
        let data = try fetchData(archiveURL)
        try verify(data, expectedSHA256: expected, assetName: assetName)
        try data.write(to: archive, options: .atomic)
        let extracted = temporary.appendingPathComponent("extracted", isDirectory: true)
        try fileManager.createDirectory(at: extracted, withIntermediateDirectories: true)
        let result = try run("/usr/bin/ditto", ["-x", "-k", archive.path, extracted.path])
        guard result.status == 0 else { throw StationError("Could not unpack Deno.") }
        let source = extracted.appendingPathComponent("deno")
        guard fileManager.fileExists(atPath: source.path) else { throw StationError("Deno executable was not found in the package.") }
        try replaceExecutable(source: source, destination: managedBinDirectory.appendingPathComponent("deno"))
    }

    private func installFFmpeg() throws {
        #if arch(arm64)
        let assets = [
            ("ffmpeg-darwin-arm64", "ffmpeg", "a90e3db6a3fd35f6074b013f948b1aa45b31c6375489d39e572bea3f18336584"),
            ("ffprobe-darwin-arm64", "ffprobe", "bb2db6f5d8cef919da12fbf592119a987202a8c060a886f3cab091f9cab90b64")
        ]
        #else
        let assets = [
            ("ffmpeg-darwin-x64", "ffmpeg", "ebdddc936f61e14049a2d4b549a412b8a40deeff6540e58a9f2a2da9e6b18894"),
            ("ffprobe-darwin-x64", "ffprobe", "fa3add0ce901f7241abe0dfc0155d958fc834aca3f8ce61f87cc712ae669c1e0")
        ]
        #endif
        let base = "https://github.com/eugeneware/ffmpeg-static/releases/download/b6.1.1"
        for asset in assets {
            try installExecutable(from: URL(string: "\(base)/\(asset.0)")!, named: asset.1, expectedSHA256: asset.2)
        }
    }

    private func installExecutable(from url: URL, named name: String, expectedSHA256: String) throws {
        let data = try fetchData(url)
        try verify(data, expectedSHA256: expectedSHA256, assetName: url.lastPathComponent)
        let temporary = managedBinDirectory.appendingPathComponent(".\(name)-\(UUID().uuidString)")
        defer { try? fileManager.removeItem(at: temporary) }
        try data.write(to: temporary, options: .atomic)
        try replaceExecutable(source: temporary, destination: managedBinDirectory.appendingPathComponent(name))
    }

    private func replaceExecutable(source: URL, destination: URL) throws {
        try fileManager.setAttributes([.posixPermissions: NSNumber(value: Int16(0o755))], ofItemAtPath: source.path)
        if fileManager.fileExists(atPath: destination.path) { try fileManager.removeItem(at: destination) }
        try fileManager.copyItem(at: source, to: destination)
        try fileManager.setAttributes([.posixPermissions: NSNumber(value: Int16(0o755))], ofItemAtPath: destination.path)
        _ = try? run("/usr/bin/xattr", ["-d", "com.apple.quarantine", destination.path])
    }

    private func fetchData(_ url: URL) throws -> Data {
        do {
            let data = try Data(contentsOf: url, options: .mappedIfSafe)
            guard !data.isEmpty else { throw StationError("The downloaded file was empty.") }
            return data
        } catch {
            throw StationError("Download failed for \(url.lastPathComponent): \(error.localizedDescription)")
        }
    }

    private func fetchText(_ url: URL) throws -> String {
        let data = try fetchData(url)
        guard let text = String(data: data, encoding: .utf8) else { throw StationError("Invalid release manifest.") }
        return text
    }

    private func checksum(named assetName: String, in manifest: String) -> String? {
        for line in manifest.split(whereSeparator: { $0.isNewline }) {
            let columns = line.split(whereSeparator: { $0.isWhitespace })
            if columns.count >= 2 && String(columns.last!) == assetName { return String(columns[0]) }
        }
        return nil
    }

    private func verify(_ data: Data, expectedSHA256: String, assetName: String) throws {
        let digest = SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
        guard digest.caseInsensitiveCompare(expectedSHA256) == .orderedSame else {
            throw StationError("Security check failed for \(assetName). Nothing was installed.")
        }
    }

    private func download(_ payload: [String: Any]) throws -> [String: Any] {
        guard let text = payload["url"] as? String,
              let url = URL(string: text),
              ["http", "https"].contains(url.scheme?.lowercased() ?? "") else {
            throw StationError("Enter a valid video URL.")
        }
        guard let ytdlp = findExecutable("yt-dlp") else { throw StationError("yt-dlp is not installed. Use Setup / Update first.") }
        let outputFolder: URL
        if let managedOutput = payload["managedVisualBrainOutput"] as? String, !managedOutput.isEmpty {
            let root = visualBrainMediaDirectory.standardizedFileURL
            let candidate = URL(fileURLWithPath: managedOutput, isDirectory: true).standardizedFileURL
            guard candidate.path.hasPrefix(root.path + "/") else { throw StationError("Visual Brain output location is invalid.") }
            outputFolder = candidate
        } else if let override = ProcessInfo.processInfo.environment["RAMIN_STATION_DOWNLOADS"], !override.isEmpty {
            outputFolder = URL(fileURLWithPath: override, isDirectory: true)
        } else {
            outputFolder = fileManager.urls(for: .downloadsDirectory, in: .userDomainMask).first!
        }
        try fileManager.createDirectory(at: outputFolder, withIntermediateDirectories: true)
        var baseArguments = ["--no-playlist", "--newline", "--retries", "5", "--fragment-retries", "5", "--progress-template", "download:RS_PROGRESS:%(progress._percent_str)s|%(progress._speed_str)s|%(progress._eta_str)s", "-o", outputFolder.appendingPathComponent("%(title)s.%(ext)s").path]

        if let deno = findExecutable("deno") { baseArguments += ["--js-runtimes", "deno:\(deno)"] }

        let mediaType = payload["mediaType"] as? String ?? "video"
        let quality = payload["quality"] as? String ?? "1080"
        if mediaType == "audio" {
            let audioQuality = quality == "128" ? "128K" : quality == "256" ? "256K" : "0"
            baseArguments += ["-x", "--audio-format", "mp3", "--audio-quality", audioQuality]
        } else {
            let height = ["1080", "720", "480"].contains(quality) ? quality : "1080"
            baseArguments += ["-f", "bestvideo[height<=\(height)]+bestaudio/best[height<=\(height)]/best", "--merge-output-format", "mp4"]
        }

        let cookieSource = payload["cookies"] as? String ?? "auto"
        let cookieFile = payload["cookieFile"] as? String ?? ""
        var authenticationAttempts: [(label: String, arguments: [String])] = [("public access", [])]
        if ["chrome", "safari", "firefox"].contains(cookieSource) {
            authenticationAttempts.append(("\(cookieSource.capitalized) cookies", ["--cookies-from-browser", cookieSource]))
        } else if cookieSource == "cookiefile" {
            guard !cookieFile.isEmpty, fileManager.fileExists(atPath: cookieFile) else { throw StationError("Choose a valid cookies.txt file first.") }
            authenticationAttempts.append(("cookies.txt", ["--cookies", cookieFile]))
        } else if cookieSource == "auto" {
            authenticationAttempts += [
                ("Chrome cookies", ["--cookies-from-browser", "chrome"]),
                ("Safari cookies", ["--cookies-from-browser", "safari"]),
                ("Firefox cookies", ["--cookies-from-browser", "firefox"])
            ]
        }

        beginJob()
        defer { finishJob() }
        emitEvent(message: "yt-dlp connected — reading media info…", progress: 1)
        var lastOutput = ""
        for (index, attempt) in authenticationAttempts.enumerated() {
            if index > 0 { emitEvent(message: "Retrying with \(attempt.label)…", progress: 1) }
            let result = try runStreaming(ytdlp, baseArguments + attempt.arguments + [text], kind: "download")
            lastOutput = result.output
            if wasCancelled() { throw StationError("Operation cancelled.") }
            if result.status == 0 {
                emitEvent(message: payload["managedVisualBrainOutput"] == nil ? "Media saved directly to Downloads" : "Media saved to Visual Brain", progress: 100)
                return ["message": "Download complete", "folder": outputFolder.path]
            }
            if index == 0 && !needsCookieRetry(result.output) { break }
        }
        throw StationError(friendlyDownloadError(lastOutput))
    }

    private func visualBrainDownload(_ payload: [String: Any]) throws -> [String: Any] {
        let directory = try visualBrainItemDirectory(payload["storageID"])
        try fileManager.createDirectory(at: visualBrainMediaDirectory, withIntermediateDirectories: true)
        if fileManager.fileExists(atPath: directory.path) { try fileManager.removeItem(at: directory) }
        try fileManager.createDirectory(at: directory, withIntermediateDirectories: true)
        do {
            var downloadPayload = payload
            downloadPayload["managedVisualBrainOutput"] = directory.path
            _ = try download(downloadPayload)
            let destination = try visualBrainStoredFile(in: directory)
            let mime = UTType(filenameExtension: destination.pathExtension)?.preferredMIMEType ?? "application/octet-stream"
            return [
                "message": "Download complete",
                "storageID": payload["storageID"] as? String ?? "",
                "name": destination.lastPathComponent,
                "title": destination.deletingPathExtension().lastPathComponent,
                "mime": mime
            ]
        } catch {
            try? fileManager.removeItem(at: directory)
            throw error
        }
    }

    private func needsCookieRetry(_ output: String) -> Bool {
        let text = output.lowercased()
        return ["cookies", "login", "sign in", "confirm you’re not a bot", "confirm you're not a bot", "po token", "http error 403"].contains { text.contains($0) }
    }

    private func friendlyDownloadError(_ output: String) -> String {
        let tail = String(output.suffix(900))
        if tail.localizedCaseInsensitiveContains("Cookies.binarycookies") ||
            (tail.localizedCaseInsensitiveContains("Operation not permitted") &&
             tail.localizedCaseInsensitiveContains("Safari")) {
            return "macOS blocked Safari cookies. Add Ramin Station in System Settings → Privacy & Security → Full Disk Access and reopen it, or choose a Netscape cookies.txt file."
        }
        if needsCookieRetry(tail) {
            return "YouTube still needs valid login cookies. Try AUTO RETRY first; if Safari is blocked by macOS privacy, choose a Netscape cookies.txt file instead."
        }
        return tail.isEmpty ? "Download failed. Use Setup / Update and try again." : tail
    }

    private func compress(_ payload: [String: Any]) throws -> [String: Any] {
        guard let sourceText = (payload["source"] as? String) ?? (payload["folder"] as? String) else { throw StationError("Choose a source file or folder.") }
        let sourceURL = URL(fileURLWithPath: sourceText).standardizedFileURL
        var isDirectory: ObjCBool = false
        guard fileManager.fileExists(atPath: sourceURL.path, isDirectory: &isDirectory) else {
            throw StationError("Choose a valid source file or folder.")
        }
        guard let ffmpeg = findExecutable("ffmpeg") else { throw StationError("FFmpeg is not installed. Use Setup / Update first.") }
        let inputType = payload["inputType"] as? String ?? "all"
        let allowed = inputType == "all" ? ["mp4", "mov", "mkv", "avi", "m4v", "webm"] : [inputType]
        let baseFolder = isDirectory.boolValue ? sourceURL : sourceURL.deletingLastPathComponent()
        let files: [URL]
        if isDirectory.boolValue {
            files = try fileManager.contentsOfDirectory(at: sourceURL, includingPropertiesForKeys: nil)
                .filter { allowed.contains($0.pathExtension.lowercased()) }
                .sorted { $0.lastPathComponent.localizedCaseInsensitiveCompare($1.lastPathComponent) == .orderedAscending }
        } else {
            guard ["mp4", "mov", "mkv", "avi", "m4v", "webm"].contains(sourceURL.pathExtension.lowercased()) else {
                throw StationError("Choose a supported video file.")
            }
            files = [sourceURL]
        }
        guard !files.isEmpty else { throw StationError("No matching video files were found.") }
        let processMode = payload["processMode"] as? String ?? "compress"
        let editReady = processMode == "decompress"
        let quality = payload["quality"] as? String ?? "balanced"
        let settings: (crf: String, audio: String) = quality == "high" ? ("21", "192k") : quality == "tiny" ? ("31", "96k") : ("26", "128k")
        let outputFolder = baseFolder.appendingPathComponent(editReady ? "Ramin Station Edit" : "Ramin Station HEVC", isDirectory: true)
        try fileManager.createDirectory(at: outputFolder, withIntermediateDirectories: true)

        beginJob()
        defer { finishJob() }
        emitEvent(message: "Found \(files.count) matching video file(s).", progress: 0)
        for (index, source) in files.enumerated() {
            if wasCancelled() { throw StationError("Operation cancelled.") }
            let destination = outputFolder.appendingPathComponent(source.deletingPathExtension().lastPathComponent + (editReady ? "_EDIT.mov" : "_HEVC.mp4"))
            let base = Double(index) / Double(files.count) * 100
            let span = 100 / Double(files.count)
            let duration = probeDuration(source)
            emitEvent(message: editReady ? "Creating edit-ready copy of \(source.lastPathComponent)…" : "Compressing \(source.lastPathComponent)…", progress: base)
            let codecArguments = editReady
                ? ["-c:v", "prores_ks", "-profile:v", "0", "-pix_fmt", "yuv422p10le", "-c:a", "pcm_s16le"]
                : ["-c:v", "libx265", "-preset", "slow", "-crf", settings.crf, "-tag:v", "hvc1", "-c:a", "aac", "-b:a", settings.audio]
            let arguments = ["-hide_banner", "-loglevel", "warning", "-y", "-i", source.path] + codecArguments + ["-progress", "pipe:1", "-nostats", destination.path]
            let result = try runStreaming(ffmpeg, arguments, kind: "transcode", progressBase: base, progressSpan: span, duration: duration)
            if wasCancelled() {
                try? fileManager.removeItem(at: destination)
                throw StationError("Operation cancelled.")
            }
            if result.status != 0 { throw StationError(String(result.output.suffix(900))) }
            emitEvent(message: "Finished \(source.lastPathComponent)", progress: base + span)
        }
        return ["message": editReady ? "\(files.count) edit-ready file(s) created" : "\(files.count) file(s) compressed", "folder": outputFolder.path]
    }

    private func probeDuration(_ source: URL) -> Double {
        guard let ffprobe = findExecutable("ffprobe"),
              let result = try? run(ffprobe, ["-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", source.path]),
              result.status == 0 else { return 0 }
        return Double(result.output.trimmingCharacters(in: .whitespacesAndNewlines)) ?? 0
    }

    private func findExecutable(_ name: String) -> String? {
        var paths = [managedBinDirectory.path]
        if ProcessInfo.processInfo.environment["RAMIN_STATION_IGNORE_SYSTEM_TOOLS"] != "1" {
            paths += ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"]
        }
        return paths.map { "\($0)/\(name)" }.first(where: fileManager.isExecutableFile)
    }

    private func processEnvironment() -> [String: String] {
        var environment = ProcessInfo.processInfo.environment
        environment["PATH"] = "\(managedBinDirectory.path):/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
        return environment
    }

    private func run(_ executable: String, _ arguments: [String]) throws -> (status: Int32, output: String) {
        let process = Process()
        let pipe = Pipe()
        process.executableURL = URL(fileURLWithPath: executable)
        process.arguments = arguments
        process.standardOutput = pipe
        process.standardError = pipe
        process.environment = processEnvironment()
        try process.run()
        let data = pipe.fileHandleForReading.readDataToEndOfFile()
        process.waitUntilExit()
        return (process.terminationStatus, String(data: data, encoding: .utf8) ?? "")
    }

    private func runStreaming(_ executable: String, _ arguments: [String], kind: String, progressBase: Double = 0, progressSpan: Double = 100, duration: Double = 0) throws -> (status: Int32, output: String) {
        let process = Process()
        let pipe = Pipe()
        process.executableURL = URL(fileURLWithPath: executable)
        process.arguments = arguments
        process.standardOutput = pipe
        process.standardError = pipe
        process.environment = processEnvironment()
        processLock.lock()
        currentProcess = process
        processLock.unlock()
        try process.run()

        var output = ""
        var pending = ""
        while true {
            let data = pipe.fileHandleForReading.availableData
            if data.isEmpty { break }
            let chunk = String(data: data, encoding: .utf8) ?? ""
            output.append(chunk)
            if output.count > 200_000 { output = String(output.suffix(100_000)) }
            pending.append(chunk)
            let lines = pending.components(separatedBy: .newlines)
            pending = lines.last ?? ""
            for line in lines.dropLast() {
                handleStreamLine(line, kind: kind, progressBase: progressBase, progressSpan: progressSpan, duration: duration)
            }
        }
        if !pending.isEmpty { handleStreamLine(pending, kind: kind, progressBase: progressBase, progressSpan: progressSpan, duration: duration) }
        process.waitUntilExit()
        processLock.lock()
        if currentProcess === process { currentProcess = nil }
        processLock.unlock()
        return (process.terminationStatus, output)
    }

    private func handleStreamLine(_ line: String, kind: String, progressBase: Double, progressSpan: Double, duration: Double) {
        let clean = line.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !clean.isEmpty else { return }
        if let range = clean.range(of: "RS_PROGRESS:") {
            let values = clean[range.upperBound...].split(separator: "|", omittingEmptySubsequences: false).map { String($0).trimmingCharacters(in: .whitespaces) }
            let percentText = values.first?.replacingOccurrences(of: "%", with: "") ?? "0"
            let percent = Double(percentText) ?? 0
            let speed = values.count > 1 ? values[1] : ""
            let eta = values.count > 2 ? values[2] : ""
            emitEvent(message: "Downloading \(Int(percent))%  •  \(speed)  •  ETA \(eta)", progress: percent)
        } else if kind != "download", duration > 0, clean.hasPrefix("out_time_us="), let microseconds = Double(clean.dropFirst("out_time_us=".count)) {
            let fraction = min(1, max(0, microseconds / 1_000_000 / duration))
            emitEvent(message: "Encoding \(Int(fraction * 100))% of current file", progress: progressBase + progressSpan * fraction)
        } else if kind == "download" && (clean.hasPrefix("[download]") || clean.hasPrefix("[ExtractAudio]") || clean.hasPrefix("[Merger]")) {
            emitEvent(message: String(clean.prefix(150)), progress: nil)
        } else if kind != "download" && !clean.contains("=") {
            emitEvent(message: String(clean.prefix(150)), progress: nil)
        }
    }

    private func beginJob() {
        processLock.lock()
        cancelRequested = false
        currentProcess = nil
        processLock.unlock()
    }

    private func finishJob() {
        processLock.lock()
        currentProcess = nil
        processLock.unlock()
    }

    private func wasCancelled() -> Bool {
        processLock.lock()
        let value = cancelRequested
        processLock.unlock()
        return value
    }

    private func emitEvent(message: String, progress: Double?) {
        var event: [String: Any] = ["message": message]
        if let progress { event["progress"] = progress }
        guard let data = try? JSONSerialization.data(withJSONObject: event),
              let json = String(data: data, encoding: .utf8) else { return }
        DispatchQueue.main.async { [weak self] in
            self?.webView.evaluateJavaScript("window.raminNativeEvent && window.raminNativeEvent(\(json));")
        }
    }

    private func respond(_ requestID: Int, _ result: [String: Any]) {
        guard JSONSerialization.isValidJSONObject(result),
              let data = try? JSONSerialization.data(withJSONObject: result),
              let json = String(data: data, encoding: .utf8) else { return }
        DispatchQueue.main.async { [weak self] in
            self?.webView.evaluateJavaScript("window.raminNativeResolve && window.raminNativeResolve(\(requestID), \(json));")
        }
    }

    private func showError(_ message: String) {
        let alert = NSAlert()
        alert.messageText = "Ramin Station"
        alert.informativeText = message
        alert.runModal()
    }
}

private struct StationError: LocalizedError {
    let message: String
    init(_ message: String) { self.message = message }
    var errorDescription: String? { message }
}
