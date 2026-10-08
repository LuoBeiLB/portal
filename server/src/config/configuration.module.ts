import { Global, Module } from '@nestjs/common';

import { PortalConfigService } from './portal-config.service';

@Global()
@Module({
  providers: [PortalConfigService],
  exports: [PortalConfigService],
})
export class ConfigurationModule {}
