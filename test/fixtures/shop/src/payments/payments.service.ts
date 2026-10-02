import { Injectable } from '@nestjs/common'
import { OrdersRepository } from '@app/orders/orders.repository.js'
import { PAYMENT_FEE } from './payments.internal.js'

@Injectable()
export class PaymentsService {
  constructor(private readonly orders: OrdersRepository) {}

  fee(amount: number) {
    return amount * PAYMENT_FEE
  }
}
