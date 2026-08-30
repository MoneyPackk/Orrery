import { ContainerModule } from "@theia/core/shared/inversify";
import { ElectronMainApplicationContribution } from "@theia/core/lib/electron-main/electron-main-application";
import { MissionControlElectronMainContribution } from "./mission-control-electron-main-contribution";

export default new ContainerModule((bind) => {
  bind(MissionControlElectronMainContribution).toSelf().inSingletonScope();
  bind(ElectronMainApplicationContribution).toService(MissionControlElectronMainContribution);
});
