// Lifts the foreground subjects out of an image with the Vision framework.
// usage: cutout <input image> <output dir>
// Writes all.png (every instance) and instance-<n>.png, full size with alpha.
import CoreImage
import Foundation
import Vision

let arguments = CommandLine.arguments
guard arguments.count == 3 else {
  FileHandle.standardError.write("usage: cutout <input> <output dir>\n".data(using: .utf8)!)
  exit(2)
}
let input = URL(fileURLWithPath: arguments[1])
let outputDir = URL(fileURLWithPath: arguments[2], isDirectory: true)

let handler = VNImageRequestHandler(url: input)
let request = VNGenerateForegroundInstanceMaskRequest()
try handler.perform([request])
guard let observation = request.results?.first else {
  print("no foreground found")
  exit(1)
}

let context = CIContext()
let sRGB = CGColorSpace(name: CGColorSpace.sRGB)!

func write(_ instances: IndexSet, to name: String) throws {
  let buffer = try observation.generateMaskedImage(ofInstances: instances, from: handler, croppedToInstancesExtent: false)
  let image = CIImage(cvPixelBuffer: buffer)
  let url = outputDir.appendingPathComponent(name)
  try context.writePNGRepresentation(of: image, to: url, format: .RGBA8, colorSpace: sRGB)
  print("\(name): instances \(Array(instances)) extent \(image.extent)")
}

print("instances found: \(observation.allInstances.count)")
try write(observation.allInstances, to: "all.png")
for instance in observation.allInstances {
  try write(IndexSet(integer: instance), to: "instance-\(instance).png")
}
