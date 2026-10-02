import { Module } from '@nestjs/common'
import { OrdersModule } from './orders/orders.module.js'
import { PaymentsModule } from './payments/index.js'
import { SHARED_MODULES } from './shared-modules.js'
import { UsersModule } from './users/users.module.js'

@Module({
  imports: [...SHARED_MODULES, OrdersModule, PaymentsModule, UsersModule],
})
export class AppModule {}
