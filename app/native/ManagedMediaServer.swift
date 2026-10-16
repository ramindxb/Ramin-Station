import Foundation
import Network
import UniformTypeIdentifiers

// Loopback-only, session-token-protected, range-capable media access for WebKit.
// Never exposes Downloads, arbitrary filesystem paths, or symlink destinations.
final class ManagedMediaServer {
    private let root: URL
    private let token = UUID().uuidString
    private let queue = DispatchQueue(label: "station.managed-media", qos: .utility, attributes: .concurrent)
    private var listener: NWListener?
    private var base: String?
    private let lock = NSLock()

    init(root: URL) { self.root = root.standardizedFileURL }

    func start() throws {
        let parameters = NWParameters.tcp
        parameters.requiredLocalEndpoint = .hostPort(host: "127.0.0.1", port: .any)
        let listener = try NWListener(using: parameters)
        self.listener = listener
        listener.stateUpdateHandler = { [weak self, weak listener] state in
            guard let self else { return }
            if case .ready = state, let port = listener?.port {
                self.lock.lock(); self.base = "http://127.0.0.1:\(port.rawValue)/\(self.token)"; self.lock.unlock()
            }
        }
        listener.newConnectionHandler = { [weak self] connection in
            guard let self else { connection.cancel(); return }
            connection.start(queue: self.queue)
            self.receive(connection, pending: Data())
        }
        listener.start(queue: queue)
    }

    func url(storageID: String, name: String) -> String? {
        lock.lock(); let base = self.base; lock.unlock()
        guard UUID(uuidString: storageID) != nil, name == (name as NSString).lastPathComponent,
              let base, let escaped = name.addingPercentEncoding(withAllowedCharacters: .alphanumerics) else { return nil }
        return "\(base)/\(storageID)/\(escaped)"
    }

    private func receive(_ connection: NWConnection, pending: Data) {
        connection.receive(minimumIncompleteLength: 1, maximumLength: 8192) { [weak self] data, _, complete, error in
            guard let self else { connection.cancel(); return }
            var request = pending
            if let data { request.append(data) }
            if request.range(of: Data("\r\n\r\n".utf8)) != nil { self.serve(connection, request: request); return }
            if complete || error != nil || request.count > 16384 { connection.cancel(); return }
            self.receive(connection, pending: request)
        }
    }

    private func serve(_ connection: NWConnection, request: Data) {
        func fail(_ code: String) {
            connection.send(content: Data("HTTP/1.1 \(code)\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".utf8), completion: .contentProcessed { _ in connection.cancel() })
        }
        let lines = String(decoding: request, as: UTF8.self).components(separatedBy: "\r\n")
        let first = (lines.first ?? "").split(separator: " ").map(String.init)
        guard first.count == 3, ["GET", "HEAD"].contains(first[0]) else { fail("405 Method Not Allowed"); return }
        let parts = first[1].components(separatedBy: "/")
        guard parts.count == 4, parts[1] == token, UUID(uuidString: parts[2]) != nil,
              let name = parts[3].removingPercentEncoding, !name.isEmpty, !name.hasPrefix("."), name == (name as NSString).lastPathComponent else { fail("404 Not Found"); return }
        let file = root.appendingPathComponent(parts[2]).appendingPathComponent(name).standardizedFileURL
        guard file.resolvingSymlinksInPath().path == file.path,
              let attributes = try? FileManager.default.attributesOfItem(atPath: file.path),
              attributes[.type] as? FileAttributeType == .typeRegular,
              let size = (attributes[.size] as? NSNumber)?.int64Value, size > 0,
              let handle = try? FileHandle(forReadingFrom: file) else { fail("404 Not Found"); return }
        var start: Int64 = 0, end = size - 1
        var partial = false
        if let range = lines.first(where: { $0.lowercased().hasPrefix("range:") }) {
            let text = range.dropFirst(6).trimmingCharacters(in: .whitespaces)
            let bounds = text.replacingOccurrences(of: "bytes=", with: "").split(separator: "-", omittingEmptySubsequences: false)
            guard text.hasPrefix("bytes="), bounds.count == 2 else { try? handle.close(); fail("416 Range Not Satisfiable"); return }
            if bounds[0].isEmpty, let suffix = Int64(bounds[1]), suffix > 0 { start = max(0, size - suffix) }
            else if let lower = Int64(bounds[0]) {
                start = lower
                if !bounds[1].isEmpty { guard let upper = Int64(bounds[1]) else { try? handle.close(); fail("416 Range Not Satisfiable"); return }; end = min(end, upper) }
            } else { try? handle.close(); fail("416 Range Not Satisfiable"); return }
            guard start >= 0, start < size, end >= start else { try? handle.close(); fail("416 Range Not Satisfiable"); return }
            partial = true
        }
        let mime = UTType(filenameExtension: file.pathExtension)?.preferredMIMEType ?? "application/octet-stream"
        let length = end - start + 1
        let headers = "HTTP/1.1 \(partial ? "206 Partial Content" : "200 OK")\r\nContent-Type: \(mime)\r\nContent-Length: \(length)\r\nAccept-Ranges: bytes\r\nAccess-Control-Allow-Origin: *\r\nCache-Control: no-store\r\nConnection: close\r\n" + (partial ? "Content-Range: bytes \(start)-\(end)/\(size)\r\n" : "") + "\r\n"
        try? handle.seek(toOffset: UInt64(start))
        connection.send(content: Data(headers.utf8), completion: .contentProcessed { [weak self] error in
            if error != nil || first[0] == "HEAD" { try? handle.close(); connection.cancel(); return }
            self?.sendFile(connection, handle: handle, remaining: length)
        })
    }

    private func sendFile(_ connection: NWConnection, handle: FileHandle, remaining: Int64) {
        guard remaining > 0, let data = try? handle.read(upToCount: Int(min(262144, remaining))), !data.isEmpty else {
            try? handle.close(); connection.cancel(); return
        }
        connection.send(content: data, completion: .contentProcessed { [weak self] error in
            if error != nil { try? handle.close(); connection.cancel(); return }
            self?.sendFile(connection, handle: handle, remaining: remaining - Int64(data.count))
        })
    }
}
