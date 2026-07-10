import { FastifyInstance } from 'fastify'
import prisma from '../lib/prisma'
import { requireAuth } from '../middleware/auth'
import { z } from 'zod'

export async function clicksRoutes(fastify: FastifyInstance) {
  fastify.addHook('preHandler', requireAuth)

  fastify.get('/', async (request, reply) => {
    const querySchema = z.object({
      period: z.enum(['today', 'yesterday', '7d', '30d', 'all']).default('today'),
    })
    
    const { period } = querySchema.parse(request.query)
    
    const now = new Date()
    let startDate = new Date(0)
    let endDate = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1)
    let groupBy: 'hour' | 'day' | 'month' = 'day'
    
    // Setup date ranges and grouping
    if (period === 'today') {
      startDate = new Date(now.getFullYear(), now.getMonth(), now.getDate())
      endDate = new Date(startDate.getTime() + 24 * 60 * 60 * 1000)
      groupBy = 'hour'
    } else if (period === 'yesterday') {
      startDate = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1)
      endDate = new Date(startDate.getTime() + 24 * 60 * 60 * 1000)
      groupBy = 'hour'
    } else if (period === '7d') {
      startDate = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 6) // Includes today
    } else if (period === '30d') {
      startDate = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 29)
    } else if (period === 'all') {
      groupBy = 'month'
    }

    const where = period !== 'all' ? {
      createdAt: {
        gte: startDate,
        lt: endDate
      }
    } : {}

    // Fetch clicks
    const clicks = await prisma.shortUrlClick.findMany({
      where,
      include: {
        shortUrl: true
      },
      orderBy: { createdAt: 'asc' }
    })

    // Prepare full range for continuous chart
    const chartDataMap = new Map<string, number>()
    
    if (period === 'today' || period === 'yesterday') {
      for (let i = 0; i < 24; i++) {
        chartDataMap.set(`${i.toString().padStart(2, '0')}:00`, 0)
      }
    } else if (period === '7d' || period === '30d') {
      let current = new Date(startDate)
      while (current < endDate) {
        const m = (current.getMonth() + 1).toString().padStart(2, '0')
        const d = current.getDate().toString().padStart(2, '0')
        chartDataMap.set(`${d}/${m}`, 0)
        current.setDate(current.getDate() + 1)
      }
    }

    const topLinksMap = new Map<string, { count: number, originalUrl: string }>()

    for (const click of clicks) {
      let bucketStr = ''
      if (groupBy === 'hour') {
        const h = click.createdAt.getHours().toString().padStart(2, '0')
        bucketStr = `${h}:00`
      } else if (groupBy === 'day') {
        const m = (click.createdAt.getMonth() + 1).toString().padStart(2, '0')
        const d = click.createdAt.getDate().toString().padStart(2, '0')
        bucketStr = `${d}/${m}`
      } else {
        const y = click.createdAt.getFullYear()
        const m = (click.createdAt.getMonth() + 1).toString().padStart(2, '0')
        bucketStr = `${m}/${y}`
        if (!chartDataMap.has(bucketStr)) chartDataMap.set(bucketStr, 0)
      }
      
      chartDataMap.set(bucketStr, (chartDataMap.get(bucketStr) || 0) + 1)
      
      // top links
      const url = click.shortUrl.originalUrl
      if (!topLinksMap.has(url)) {
        topLinksMap.set(url, { count: 0, originalUrl: url })
      }
      topLinksMap.get(url)!.count += 1
    }

    const chartData = Array.from(chartDataMap.entries()).map(([date, count]) => ({ date, clicks: count }))
    
    // Sort top links
    const topLinks = Array.from(topLinksMap.values())
      .sort((a, b) => b.count - a.count)
      .slice(0, 5)

    return {
      total: clicks.length,
      chartData,
      topLinks
    }
  })
}
