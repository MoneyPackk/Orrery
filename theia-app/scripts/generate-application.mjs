import { ApplicationPackage } from "@theia/application-package";
import { BackendGenerator } from "@theia/application-manager/lib/generator/backend-generator.js";
import { FrontendGenerator } from "@theia/application-manager/lib/generator/frontend-generator.js";

const application = new ApplicationPackage({ projectPath: process.cwd() });
if (!application.isElectron()) throw new Error("Orrery Theia host must generate the Electron target.");

await Promise.all([
  new BackendGenerator(application).generate(),
  new FrontendGenerator(application).generate()
]);

console.log(`Generated Theia ${application.target} metadata with ${application.electronMainModules.size} electron-main modules and ${application.preloadModules.size} preload modules.`);
