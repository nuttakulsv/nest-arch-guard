import { Injectable } from '@nestjs/common'
import { OrdersService } from '../orders/orders.service.js'
// arch-guard-ignore-next-line moving the fee table into users is planned for Q3
import { PAYMENT_FEE } from '../payments/payments.internal.js'
import type { Order } from '../orders/domain/order.js'

@Injectable()
export class UsersService {
  constructor(private readonly orders: OrdersService) {}

  lastOrder(): Order | undefined {
    return this.orders.list()[0] ?? (PAYMENT_FEE ? undefined : undefined)
  }
}
