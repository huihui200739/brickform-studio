import Foundation
import Vision
import CoreImage
import ImageIO
import UniformTypeIdentifiers

// Use the operating system's foreground mask; no image is sent to a server.
let args = CommandLine.arguments
guard args.count == 3, let image = CIImage(contentsOf: URL(fileURLWithPath: args[1])) else {
    fputs("Usage: prepare-local-image input.png output.png\n", stderr); exit(2)
}
let context = CIContext()
guard let cg = context.createCGImage(image, from: image.extent) else { exit(2) }
let handler = VNImageRequestHandler(cgImage: cg)
let request = VNGenerateForegroundInstanceMaskRequest()
do {
    try handler.perform([request])
    guard let result = request.results?.first, !result.allInstances.isEmpty else {
        throw NSError(domain: "Brickform", code: 1, userInfo: [NSLocalizedDescriptionKey: "No foreground detected"])
    }
    let mask = try result.generateScaledMaskForImage(forInstances: result.allInstances, from: handler)
    let clear = CIImage(color: .clear).cropped(to: image.extent)
    let cutout = image.applyingFilter("CIBlendWithMask", parameters: [kCIInputBackgroundImageKey: clear, kCIInputMaskImageKey: CIImage(cvPixelBuffer: mask)])
    try context.writePNGRepresentation(of: cutout, to: URL(fileURLWithPath: args[2]), format: .RGBA8, colorSpace: CGColorSpace(name: CGColorSpace.sRGB)!)
    print("Foreground ready")
} catch {
    fputs("Foreground mask unavailable: \(error.localizedDescription)\n", stderr); exit(1)
}
