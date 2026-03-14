import { NextRequest, NextResponse } from 'next/server'
import {
  BedrockRuntimeClient,
  ConverseCommand,
  InvokeModelCommand
} from "@aws-sdk/client-bedrock-runtime"
import { Pinecone } from '@pinecone-database/pinecone'
import { createClient } from '@supabase/supabase-js'
import { products as defaultProducts, Product, toRupees } from '@/lib/products'

// ── Clients ──────────────────────────────────────────────────────────────────
// AWS uses environment credentials (AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_REGION)
// or a Bearer Token if provided via AWS_BEARER_TOKEN_BEDROCK
const bedrock = new BedrockRuntimeClient({
  region: process.env.AWS_REGION || "us-east-1",
  // If using bearer token, provide dummy credentials to avoid loading error
  credentials: process.env.AWS_BEARER_TOKEN_BEDROCK
    ? { accessKeyId: 'dummy', secretAccessKey: 'dummy' }
    : undefined
})

// ── Bearer Token Middleware ──────────────────────────────────────────────────
if (process.env.AWS_BEARER_TOKEN_BEDROCK) {
  bedrock.middlewareStack.add(
    (next) => (args: any) => {
      args.request.headers["Authorization"] = `Bearer ${process.env.AWS_BEARER_TOKEN_BEDROCK}`;
      return next(args);
    },
    {
      step: "build",
      name: "addBearerToken",
    }
  );
}

const pinecone = new Pinecone({ apiKey: process.env.PINECONE_API_KEY! })

function getSupabaseAdmin() {
  if (!process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY) {
    console.warn('⚠️ NEXT_PUBLIC_SUPABASE_ANON_KEY missing, some features disabled')
    return null
  }
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  )
}

// ── Constants ─────────────────────────────────────────────────────────────────
const CHAT_MODEL = "anthropic.claude-3-haiku-20240307-v1:0"
const EMBED_MODEL = "amazon.titan-embed-text-v2:0"
const EMBED_DIMS = 1024
const SIMILARITY_THRESHOLD = 0.50
const TOP_K = 3

// ── Types ─────────────────────────────────────────────────────────────────────
interface ParsedItem {
  raw_name: string
  quantity: number
}

export interface ResolvedItem {
  product_id: string
  name: string
  emoji: string
  quantity: number
  unit_price_paisa: number
  subtotal_paisa: number
  subtotal_rupees: number
  score: number
}

interface PineconeMatch {
  id: string
  score: number
  metadata: {
    name: string
    base_price_paisa: number
    emoji: string
  }
}


// ── Step 1: Extract items via GPT with json_object format ─────────────────────
async function extractItems(message: string): Promise<ParsedItem[]> {
  const command = new ConverseCommand({
    modelId: CHAT_MODEL,
    messages: [
      {
        role: "user",
        content: [{
          text: `You extract order items from a customer message.
Return ONLY a JSON object: {"items": [{"raw_name": string, "quantity": number}]}
Rules:
- quantity >= 1, default to 1 if not mentioned
- normalise: "a"/"an"/"one"=1, "two"=2, "three"=3, "four"=4, "five"=5
- strip filler: "please", "want", "give me", "I'd like"
- if nothing looks like an order return {"items": []}
Example: "2 cheese burgers and a coke" → {"items":[{"raw_name":"cheese burger","quantity":2},{"raw_name":"coke","quantity":1}]}` }]
      },
      { role: 'user', content: [{ text: message }] }
    ],
    inferenceConfig: { maxTokens: 512, temperature: 0 }
  });

  try {
    const response = await bedrock.send(command);
    const text = response.output?.message?.content?.[0]?.text ?? '{"items":[]}';

    // Basic cleanup in case Claude adds markdown blocks
    const cleanJson = text.replace(/```json|```/g, "").trim();
    const parsed = JSON.parse(cleanJson);
    return Array.isArray(parsed.items) ? parsed.items : [];
  } catch (err) {
    console.error('❌ Bedrock extraction failed:', err);
    return [];
  }
}

// ── Step 2: Embed text ────────────────────────────────────────────────────────
async function embed(text: string): Promise<number[]> {
  const body = JSON.stringify({
    inputText: text,
    dimensions: EMBED_DIMS,
    normalize: true
  });

  const command = new InvokeModelCommand({
    modelId: EMBED_MODEL,
    contentType: "application/json",
    accept: "application/json",
    body: body
  });

  const response = await bedrock.send(command);
  const responseBody = JSON.parse(new TextDecoder().decode(response.body));
  return responseBody.embedding;
}

// ── Step 3: Search Pinecone ───────────────────────────────────────────────────
async function searchPinecone(vector: number[]): Promise<PineconeMatch[]> {
  const index = pinecone.Index(process.env.PINECONE_INDEX_NAME ?? 'products')
  const result = await index.query({
    vector,
    topK: TOP_K,
    includeMetadata: true,
  })
  return (result.matches ?? []) as unknown as PineconeMatch[]
}

// ── Step 4: Check inventory + get live price ──────────────────────────────────
async function checkInventory(
  productId: string,
  requestedQty: number
): Promise<number | null> {
  const supabaseAdmin = getSupabaseAdmin()
  if (!supabaseAdmin) {
    console.warn('⚠️ Inventory check unavailable')
    return null
  }

  const { data, error } = await supabaseAdmin
    .from('inventory')
    .select('current_price_paisa, stock_quantity')
    .eq('product_id', productId)
    .single()

  console.log('🏪 Inventory check:', { productId, data, error })

  if (error || !data) return null
  if ((data.stock_quantity as number ?? 0) < requestedQty) return null
  return data.current_price_paisa as number
}

// ── Step 5b: Check for ambiguous category (e.g. "pizza" matches multiple) ──
function findAmbiguousMatches(rawName: string, allProducts: Product[]): Product[] {
  const lower = rawName.toLowerCase()
  return allProducts.filter(p =>
    p.name.toLowerCase().includes(lower) ||
    lower.includes(p.name.toLowerCase().split(' ')[0])
  )
}

// ── Step 5: Pairing recommendation ───────────────────────────────────────────
async function getPairingRecommendation(
  orderedNames: string[],
  allProducts: Product[]
): Promise<string> {
  const otherItems = allProducts
    .filter(p => !orderedNames.includes(p.name))
    .slice(0, 4)
    .map(p => `${p.emoji} ${p.name}`)
    .join(', ')

  if (!otherItems) return ''

  const command = new ConverseCommand({
    modelId: CHAT_MODEL,
    messages: [{
      role: "user",
      content: [{ text: `Customer ordered: ${orderedNames.join(', ')}. Other available: ${otherItems}. Suggest 1 pairing in 1 friendly sentence. Return empty string if no good pairing.` }]
    }],
    inferenceConfig: { maxTokens: 100, temperature: 0.7 }
  });

  try {
    const resp = await bedrock.send(command);
    return resp.output?.message?.content?.[0]?.text?.trim() ?? ''
  } catch {
    return ''
  }
}

// ── Fallback: local keyword parser ───────────────────────────────────────────
function localParse(msg: string, productList: Product[]): ParsedItem[] {
  const lower = msg.toLowerCase()
  const numberWords: Record<string, number> = {
    'a': 1, 'an': 1, 'one': 1, 'two': 2, 'three': 3, 'four': 4, 'five': 5
  }
  const found: ParsedItem[] = []

  for (const p of productList) {
    const name = p.name.toLowerCase()
    let qty = 0
    const numMatch = lower.match(new RegExp(`(\\d+)\\s*${name}`))
    if (numMatch) qty = parseInt(numMatch[1])
    if (!qty) {
      for (const [w, n] of Object.entries(numberWords)) {
        if (lower.includes(`${w} ${name}`)) { qty = n; break }
      }
    }
    if (!qty && lower.includes(name)) qty = 1
    if (qty) found.push({ raw_name: p.name, quantity: qty })
  }
  return found
}

// ── Fetch products from Supabase ──────────────────────────────────────────────
async function fetchProducts(): Promise<Product[]> {
  try {
    const supabaseAdmin = getSupabaseAdmin()
    if (!supabaseAdmin) throw new Error('No Supabase')

    const { data, error } = await supabaseAdmin
      .from('products')
      .select('id, name, base_price_paisa, emoji')
    if (error || !data?.length) throw new Error('Empty')

    // Auto-detect if prices are stored as rupees instead of paisa
    // Fallback products have values like 12000 (paisa), but Supabase may have 120 (rupees)
    const maxPrice = Math.max(...data.map(p => p.base_price_paisa))
    if (maxPrice < 100000) {
      // Prices look like rupees, convert to paisa
      console.warn('⚠️ Supabase prices appear to be in rupees, converting to paisa (×100)')
      return data.map(p => ({
        ...p,
        base_price_paisa: p.base_price_paisa * 100
      }))
    }

    return data
  } catch {
    console.warn('⚠️ Using default products fallback')
    return defaultProducts
  }
}

// ── Main handler ──────────────────────────────────────────────────────────────
export async function POST(req: NextRequest) {
  try {
    const { message } = await req.json()

    if (!message?.trim()) {
      return NextResponse.json({
        success: false,
        reply: '🍽️ Hey there! 👋 I\'m here to help you order. What sounds good to you today?\n\nTry saying something like: "2 burgers and a coke" 😊'
      })
    }

    console.log('📨 Message:', message)

    // Load products from Supabase
    const allProducts = await fetchProducts()
    console.log('📦 Products loaded:', allProducts.length)

    const lowerMsg = message.toLowerCase().trim()
    const menuDisplay = allProducts
      .map(p => `${p.emoji} ${p.name} — ₹${toRupees(p.base_price_paisa)}`)
      .join('\n')

    // ── Menu Guard Rail ──────────────────────────────────────────────────────
    const menuKeywords = [
      'what you have', 'what do you have', 'what\'s available', 'whats available',
      'show menu', 'show me menu', 'menu', 'what can i order', 'what can i get',
      'what are the options', 'options', 'available', 'list', 'items',
      'what all', 'tell me', 'show me', 'what you got', 'whatcha got',
      'what orders you have', 'what orders', 'products', 'available items',
      'what food', 'list of items', 'show products'
    ]
    const isMenuRequest = menuKeywords.some(k => lowerMsg.includes(k))

    if (isMenuRequest) {
      return NextResponse.json({
        success: false,
        reply: `Sure! Here's what we have 😋\n\n${menuDisplay}\n\nJust tell me what you'd like! Example: "2 classic burgers and 1 coke" 🛍️`
      })
    }

    // Step 1: Extract items via GPT
    let parsedItems: ParsedItem[] = []
    try {
      parsedItems = await extractItems(message)
      console.log('🤖 GPT extracted:', parsedItems)
    } catch {
      console.warn('⚠️ GPT extraction failed, using local parser')
    }

    // Fallback to local parser
    if (!parsedItems.length) {
      parsedItems = localParse(message, allProducts)
      console.log('🔍 Local parser found:', parsedItems)
    }

    if (!parsedItems.length) {
      // Check if it's an ambiguous category like "pizza" or "burger"
      const categoryMatches = allProducts.filter(p =>
        p.name.toLowerCase().includes(lowerMsg) ||
        lowerMsg.includes(p.name.toLowerCase().split(' ')[0])
      )

      if (categoryMatches.length > 1) {
        const options = categoryMatches
          .map((p, i) => `${i + 1}. ${p.emoji} ${p.name} — ₹${toRupees(p.base_price_paisa)}`)
          .join('\n')
        return NextResponse.json({
          success: false,
          ambiguous: true,
          category: lowerMsg,
          matches: categoryMatches,
          reply: `🤔 We have ${categoryMatches.length} types of ${lowerMsg}!\n\n${options}\n\nWhich one would you like? Just reply with the number or name! 😊`
        })
      }

      return NextResponse.json({
        success: false,
        reply: `Hmm, I didn't quite catch that! 👂\n\n✨ Here's what we've got:\n\n${menuDisplay}\n\nFeel free to order any combo! Example: "1 cheese burger, 2 fries, 1 coke" 🤤`
      })
    }

    // Steps 2+3+4: Embed → Pinecone → Inventory check
    const resolvedItems: ResolvedItem[] = []
    const suggestions: string[] = []

    for (const parsed of parsedItems) {
      console.log('🔍 Processing:', parsed.raw_name)

      let bestMatch: PineconeMatch | null = null
      const lowerRaw = parsed.raw_name.toLowerCase().trim()

      // ── Priority 1: Direct/Direct-ish Match ──
      // This catches "coke" -> "Coke 500ml" immediately
      const directMatch = allProducts.find(p => {
        const lowerName = p.name.toLowerCase()
        return lowerName === lowerRaw ||
          lowerName.includes(lowerRaw) ||
          lowerRaw.includes(lowerName.split(' ')[0])
      })

      if (directMatch) {
        console.log('✅ Direct match found:', directMatch.name)
        bestMatch = {
          id: directMatch.id,
          score: 1.0,
          metadata: {
            name: directMatch.name,
            base_price_paisa: directMatch.base_price_paisa,
            emoji: directMatch.emoji
          }
        }
      }

      // ── Priority 2: Semantic Search (Pinecone) ──
      if (!bestMatch) {
        try {
          const vector = await embed(parsed.raw_name)
          const matches = await searchPinecone(vector)

          // Filter out extreme noise (anything below 0.20 is usually irrelevant)
          const validMatches = matches.filter(m => m.score >= 0.20)
          console.log('📍 Valid Pinecone matches:', validMatches.map(m => `${m.metadata.name}(${m.score.toFixed(2)})`))

          if (validMatches[0]?.score >= SIMILARITY_THRESHOLD) {
            bestMatch = validMatches[0]
          } else if (validMatches.length > 0) {
            // Weak match — suggest alternatives
            const alts = validMatches
              .slice(0, 3)
              .map(m => `${m.metadata.emoji} ${m.metadata.name}`)
              .join(', ')
            suggestions.push(`"${parsed.raw_name}" not found — did you mean: ${alts}?`)
            continue
          }
        } catch {
          console.warn('⚠️ Semantic search failed')
        }
      }

      if (!bestMatch) {
        suggestions.push(`"${parsed.raw_name}" not found on our menu`)
        continue
      }

      // Check inventory + get live price
      const livePrice = await checkInventory(bestMatch.id, parsed.quantity)
      if (livePrice === null) {
        // Fall back to product base price if inventory check fails
        const fallbackPrice = bestMatch.metadata.base_price_paisa
        console.warn(`⚠️ Inventory check failed for ${bestMatch.metadata.name}, using base price`)
        resolvedItems.push({
          product_id: bestMatch.id,
          name: bestMatch.metadata.name,
          emoji: bestMatch.metadata.emoji,
          quantity: parsed.quantity,
          unit_price_paisa: fallbackPrice,
          subtotal_paisa: fallbackPrice * parsed.quantity,
          subtotal_rupees: toRupees(fallbackPrice * parsed.quantity),
          score: bestMatch.score
        })
        continue
      }

      resolvedItems.push({
        product_id: bestMatch.id,
        name: bestMatch.metadata.name,
        emoji: bestMatch.metadata.emoji,
        quantity: parsed.quantity,
        unit_price_paisa: livePrice,
        subtotal_paisa: livePrice * parsed.quantity,
        subtotal_rupees: toRupees(livePrice * parsed.quantity),
        score: bestMatch.score
      })
    }

    // Surface suggestions if any items couldn't be resolved
    if (resolvedItems.length === 0 && suggestions.length > 0) {
      const suggestionsFormatted = suggestions
        .map(s => `  • ${s}`)
        .join('\n')
      return NextResponse.json({
        success: false,
        reply: `I couldn't find some items you mentioned:\n\n${suggestionsFormatted}\n\n💡 Go ahead and pick from our menu - we've got tasty options for you! 🍕🍔🥤`
      })
    }

    // Partial order — show what we found + what we couldn't
    const totalPaisa = resolvedItems.reduce((s, i) => s + i.subtotal_paisa, 0)
    const totalRupees = toRupees(totalPaisa)

    const summary = resolvedItems
      .map(i => `${i.emoji} ${i.quantity}x ${i.name} = ₹${i.subtotal_rupees}`)
      .join('\n')

    // Get pairing recommendation
    const pairingText = await getPairingRecommendation(
      resolvedItems.map(i => i.name),
      allProducts
    )

    const suggestionsText = suggestions.length > 0
      ? `\n\n💬 Heads up: We couldn't find: ${suggestions.join(', ')}. But hey, you can still enjoy these delicious items! 😋`
      : ''

    return NextResponse.json({
      success: true,
      orderItems: resolvedItems,
      totalPaisa,
      total: totalRupees,
      reply: `🎉 Perfect! Here's your delicious order:\n\n${summary}\n\n💰 Total: ₹${totalRupees}${pairingText ? '\n\n' + pairingText : ''}${suggestionsText}\n\n✨ Setting up your payment now...`
    })

  } catch (err: unknown) {
    const error = err as { message?: string }
    console.error('❌ extract-order error:', err)
    return NextResponse.json({
      success: false,
      reply: error.message ?? 'Something went wrong. Please try again! 😊'
    }, { status: 500 })
  }
}