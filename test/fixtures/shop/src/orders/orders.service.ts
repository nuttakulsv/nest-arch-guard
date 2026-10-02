import { forwardRef, Inject, Injectable } from '@nestjs/common'
import { PaymentsService } from '../payments/payments.service.js'
import { OrdersRepository } from './orders.repository.js'

@Injectable()
export class OrdersService {
  constructor(
    private readonly repo: OrdersRepository,
    @Inject(forwardRef(() => PaymentsService)) private readonly payments: PaymentsService,
  ) {}

  list() {
    return this.repo.all()
  }
}
