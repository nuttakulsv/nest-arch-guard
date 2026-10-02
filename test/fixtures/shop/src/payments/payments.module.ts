import { forwardRef, Module } from '@nestjs/common'
import { OrdersModule } from '../orders/orders.module.js'
import { PaymentsService } from './payments.service.js'

@Module({
  imports: [forwardRef(() => OrdersModule)],
  providers: [PaymentsService],
  exports: [PaymentsService],
})
export class PaymentsModule {}
