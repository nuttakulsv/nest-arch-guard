import { Controller, Get } from '@nestjs/common'
import { Logger } from '../logging/logger.js'
import { PAYMENT_FEE } from '../payments/payments.internal.js'
import { OrdersService } from './orders.service.js'

@Controller('orders')
export class OrdersController {
  constructor(
    private readonly orders: OrdersService,
    private readonly logger: Logger,
  ) {}

  @Get()
  list() {
    this.logger.log(`fee ${PAYMENT_FEE}`)
    return this.orders.list()
  }
}
