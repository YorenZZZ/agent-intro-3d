// Soft foreground mattes for a run of video frames, with the Vision framework.
// usage: matte <output dir> <frame image>...
// Writes <frame name>.png into the output dir: an 8-bit grey mask the size of
// the frame, 255 where the subject is. A frame with no subject gets an all
// black mask, so the frame count always matches.
import CoreImage
import Foundation
import Vision

let arguments = CommandLine.arguments
guard arguments.count >= 3 else {
  FileHandle.standardError.write("usage: matte <output dir> <frame>...\n".data(using: .utf8)!)
  exit(2)
}
let outputDir = URL(fileURLWithPath: arguments[1], isDirectory: true)
let context = CIContext()
let grey = CGColorSpace(name: CGColorSpace.linearGray)!

for path in arguments[2...] {
  let input = URL(fileURLWithPath: path)
  let out = outputDir.appendingPathComponent(input.deletingPathExtension().lastPathComponent + ".png")
  let handler = VNImageRequestHandler(url: input)
  let request = VNGenerateForegroundInstanceMaskRequest()
  try handler.perform([request])
  guard let source = CIImage(contentsOf: input) else { exit(1) }
  var mask = CIImage(color: .black).cropped(to: source.extent)
  if let observation = request.results?.first {
    let buffer = try observation.generateScaledMaskForImage(forInstances: observation.allInstances, from: handler)
    mask = CIImage(cvPixelBuffer: buffer)
  }
  try context.writePNGRepresentation(of: mask, to: out, format: .L8, colorSpace: grey)
}
print("mattes: \(arguments.count - 2)")
