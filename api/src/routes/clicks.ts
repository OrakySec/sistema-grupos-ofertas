import { FastifyInstance } from 'fastify'
import prisma from '../lib/prisma'
import { requireAuth } from '../middleware/auth'
import { z } from 'zod'
import { brtDayStart, brtHourLabel, brtDayLabel, brtMonthLabel, toBrt } from '../lib/time'

// What counts as a "click" in the panel: a real person (HUMAN) plus clicks
// logged before the human/bot classification existed (LEGACY — they can't be
// told apart, so they're kept to preserve history, and flagged in the response).
const COUNTED_KINDS = ['HUMAN', 'LEGACY']

export async function clicksRoutes(fastify: FastifyInstance) {
  fastify.addHook('preHandler', requireAuth)

  fastify.get('/', async (request, reply) => {
    const querySchema = z.object({
      period: z.enum(['today', 'yesterday', '7d', '30d', 'all']).default('today'),
    })

    const { period } = querySchema.parse(request.query)

    // All boundaries are Brasília days (UTC-3), matching Mercado Livre's own
    // panel — the server runs in UTC, so plain Date math would be 3h off.
    let startDate = new Date(0)
    let endDate = brtDayStart(-1) // tomorrow 00:00 BRT
    let groupBy: 'hour' | 'day' | 'month' = 'day'

    if (period === 'today') {
      startDate = brtDayStart(0)
      endDate = brtDayStart(-1)
      groupBy = 'hour'
    } else if (period === 'yesterday') {
      startDate = brtDayStart(1)
      endDate = brtDayStart(0)
      groupBy = 'hour'
    } else if (period === '7d') {
      startDate = brtDayStart(6) // includes today
    } else if (period === '30d') {
      startDate = brtDayStart(29)
    } else if (period === 'all') {
      groupBy = 'month'
    }

    const where = period !== 'all' ? { createdAt: { gte: startDate, lt: endDate } } : {}

    const clicks = await prisma.shortUrlClick.findMany({
      where,
      select: {
        createdAt: true,
        kind: true,
        agent: true,
        userAgent: true,
        ipHash: true,
        code: true,
        shortUrl: { select: { originalUrl: true } },
      },
      orderBy: { createdAt: 'asc' },
    })

    // Full range up front so the chart has no gaps
    const chartDataMap = new Map<string, number>()
    if (groupBy === 'hour') {
      for (let i = 0; i < 24; i++) chartDataMap.set(`${i.toString().padStart(2, '0')}:00`, 0)
    } else if (period === '7d' || period === '30d') {
      const days = period === '7d' ? 7 : 30
      for (let k = days - 1; k >= 0; k--) chartDataMap.set(brtDayLabel(brtDayStart(k)), 0)
    }

    const topLinksMap = new Map<string, { count: number; originalUrl: string }>()
    const botAgents = new Map<string, number>()
    const botSamples = new Map<string, number>()
    const uniqueVisitors = new Set<string>()
    let human = 0
    let legacy = 0
    let duplicate = 0
    let bot = 0

    for (const click of clicks) {
      if (click.kind === 'BOT') {
        bot++
        const agent = click.agent ?? 'Outros robôs'
        botAgents.set(agent, (botAgents.get(agent) ?? 0) + 1)
        // Raw User-Agents of the catch-all bucket, so a wrong rule is visible
        if (agent === 'Outros robôs' && click.userAgent) {
          botSamples.set(click.userAgent, (botSamples.get(click.userAgent) ?? 0) + 1)
        }
        continue
      }
      if (click.kind === 'DUPLICATE') {
        duplicate++
        continue
      }
      if (!COUNTED_KINDS.includes(click.kind)) continue

      if (click.kind === 'HUMAN') human++
      else legacy++
      if (click.ipHash) uniqueVisitors.add(`${click.ipHash}|${click.code}`)

      let bucket: string
      if (groupBy === 'hour') bucket = brtHourLabel(click.createdAt)
      else if (groupBy === 'day') bucket = brtDayLabel(click.createdAt)
      else {
        bucket = brtMonthLabel(click.createdAt)
        if (!chartDataMap.has(bucket)) chartDataMap.set(bucket, 0)
      }
      chartDataMap.set(bucket, (chartDataMap.get(bucket) ?? 0) + 1)

      const url = click.shortUrl.originalUrl
      const entry = topLinksMap.get(url) ?? { count: 0, originalUrl: url }
      entry.count += 1
      topLinksMap.set(url, entry)
    }

    const chartData = Array.from(chartDataMap.entries()).map(([date, count]) => ({ date, clicks: count }))
    const topLinks = Array.from(topLinksMap.values()).sort((a, b) => b.count - a.count).slice(0, 5)
    const sortDesc = <T extends { count: number }>(rows: T[]) => rows.sort((a, b) => b.count - a.count)

    return {
      total: human + legacy,
      chartData,
      topLinks,
      breakdown: {
        human,
        legacy,
        duplicate,
        bot,
        // distinct (visitor, link) pairs among the counted clicks; legacy rows
        // carry no visitor id so they're not part of this number
        uniqueVisitors: uniqueVisitors.size,
        allRequests: clicks.length,
      },
      botAgents: sortDesc(Array.from(botAgents.entries()).map(([agent, count]) => ({ agent, count }))),
      botSamples: sortDesc(Array.from(botSamples.entries()).map(([userAgent, count]) => ({ userAgent, count }))).slice(0, 5),
      timezone: 'America/Sao_Paulo',
      periodStart: period === 'all' ? null : toBrt(startDate).toISOString().slice(0, 10),
    }
  })
}
