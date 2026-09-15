// macOS Vision 프레임워크로 이미지의 글자를 읽어 JSON 줄로 출력한다. 인자: 이미지 경로들.
// 출력: {"file": ..., "lines": [{"text": ..., "confidence": ..., "box": [x, y, w, h]}]} (box는 0~1 정규화, 좌상단 기준)
import Foundation
import Vision
import AppKit

func recognize(_ path: String) -> [String: Any] {
    guard let image = NSImage(contentsOfFile: path),
          let cg = image.cgImage(forProposedRect: nil, context: nil, hints: nil) else {
        return ["file": path, "error": "이미지를 열 수 없음"]
    }
    let request = VNRecognizeTextRequest()
    request.recognitionLevel = .accurate
    request.recognitionLanguages = ["ko-KR", "en-US"]
    request.usesLanguageCorrection = false
    let handler = VNImageRequestHandler(cgImage: cg, options: [:])
    do { try handler.perform([request]) } catch { return ["file": path, "error": "\(error)"] }
    var lines: [[String: Any]] = []
    for obs in request.results ?? [] {
        guard let top = obs.topCandidates(1).first else { continue }
        let b = obs.boundingBox
        lines.append(["text": top.string, "confidence": Double(top.confidence),
                      "box": [Double(b.minX), Double(1 - b.maxY), Double(b.width), Double(b.height)]])
    }
    lines.sort { ($0["box"] as! [Double])[1] < ($1["box"] as! [Double])[1] }
    return ["file": path, "lines": lines]
}

for path in CommandLine.arguments.dropFirst() {
    let result = recognize(path)
    let data = try! JSONSerialization.data(withJSONObject: result, options: [.withoutEscapingSlashes])
    print(String(data: data, encoding: .utf8)!)
}
