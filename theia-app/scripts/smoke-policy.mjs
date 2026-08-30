export function classifyNativePreparationFailure(output) {
  if (/@theia[\\/]ffmpeg[\s\S]{0,300}ffmpeg\.node|ffmpeg\.node[\s\S]{0,300}@theia[\\/]ffmpeg/i.test(output)) return "@theia/ffmpeg ffmpeg.node";
  if (/drivelist[\s\S]{0,500}(?:node-gyp|gyp ERR|native build|build failed|rebuild failed)/i.test(output)) return "drivelist native build";
  return null;
}
