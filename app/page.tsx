'use client'
import { useState } from 'react'

interface OrderItem {
  emoji: string
  name: string
  quantity: number
  subtotal_rupees: number
}

interface Message {
  role: 'customer' | 'agent'
  content: string
  timestamp: string
  paymentLink?: string
  orderItems?: OrderItem[]
  orderTotal?: number
}

interface CustomerInfo {
  name: string
  phone: string
  email: string
}

// Returns a consistent HH:MM timestamp safe for both SSR and client
function getTimestamp(): string {
  const now = new Date()
  const h = String(now.getHours()).padStart(2, '0')
  const m = String(now.getMinutes()).padStart(2, '0')
  return `${h}:${m}`
}

export default function ChatPage() {
  const [messages, setMessages] = useState<Message[]>([
    {
      role: 'agent',
      content: '🍽️ Hey there! 👋 Welcome to QuickShop!\n\n🛍️ Your AI-powered food ordering buddy is here!\n\nBefore we start, what\'s your name and phone number?\n\nExample: "John, 9876543210"',
      timestamp: '' // Empty on purpose — avoids SSR/client mismatch
    }
  ])
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const [customer, setCustomer] = useState<CustomerInfo | null>(null)
  const [awaitingCustomerInfo, setAwaitingCustomerInfo] = useState(true)

  const parseCustomerInfo = (msg: string): CustomerInfo | null => {
    // Match "Name, phone" or "Name phone" patterns
    const match = msg.match(/([a-zA-Z\s]+)[,\s]+(\d{10})/)
    if (!match) return null
    const name = match[1].trim()
    const phone = match[2].trim()
    const email = `${name.toLowerCase().replace(/\s+/g, '.')}@customer.quickshop.com`
    return { name, phone, email }
  }

  const sendMessage = async () => {
    if (!input.trim()) return

    const userMessage: Message = {
      role: 'customer',
      content: input,
      timestamp: getTimestamp()
    }

    setMessages(prev => [...prev, userMessage])
    const currentInput = input
    setInput('')
    setLoading(true)

    // Handle customer info collection
    if (awaitingCustomerInfo) {
      const info = parseCustomerInfo(currentInput)
      if (!info) {
        setMessages(prev => [...prev, {
          role: 'agent',
          content: 'Oops! I need both your name and number 😊\n\nExample: "Rahul, 9876543210"',
          timestamp: getTimestamp()
        }])
        setLoading(false)
        return
      }

      setCustomer(info)
      setAwaitingCustomerInfo(false)
      setMessages(prev => [...prev, {
        role: 'agent',
        content: `🎉 Perfect! Great to meet you ${info.name}!\n\nWhat would you like to order today? 😋\n\nExample: "2 classic burgers and 1 coke"`,
        timestamp: getTimestamp()
      }])
      setLoading(false)
      return
    }

    // Normal order flow
    if (!customer) {
      setLoading(false)
      return
    }

    try {
      // Step 1: Extract order
      const extractRes = await fetch('/api/extract-order', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: currentInput })
      })
      const extractData = await extractRes.json()

      setMessages(prev => [...prev, {
        role: 'agent',
        content: extractData.reply,
        timestamp: getTimestamp()
      }])

      // Step 2: Create payment if order found
      if (extractData.success) {
        const payRes = await fetch('/api/create-payment', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            orderItems: extractData.orderItems,
            total: extractData.total,
            totalPaisa: extractData.totalPaisa,
            customerName: customer.name,
            customerPhone: customer.phone,
            customerEmail: customer.email
          })
        })
        const payData = await payRes.json()

        // Show confirmation message
        setMessages(prev => [...prev, {
          role: 'agent',
          content: payData.reply,
          timestamp: getTimestamp()
        }])

        // Show payment button with order summary
        if (payData.paymentLink) {
          setMessages(prev => [...prev, {
            role: 'agent',
            content: `💳 TAP TO PAY: ${payData.paymentLink}`,
            timestamp: getTimestamp(),
            paymentLink: payData.paymentLink,
            orderItems: extractData.orderItems,
            orderTotal: extractData.total
          }])
        }
      }
    } catch (e) {
      console.error('Order error:', e)
      setMessages(prev => [...prev, {
        role: 'agent',
        content: '😅 Oops! Something hiccupped. No worries - please try again! We\'re here to help 🚀',
        timestamp: getTimestamp()
      }])
    }

    setLoading(false)
  }

  return (
    <div className="min-h-screen bg-gray-50 flex items-center justify-center p-4">
      <div className="w-full max-w-md bg-white rounded-2xl shadow-xl overflow-hidden">

        {/* Header */}
        <div className="bg-green-600 p-4 text-white">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 bg-white rounded-full flex items-center justify-center text-green-600 font-bold text-lg">Q</div>
            <div>
              <h1 className="font-bold text-lg">QuickShop Assistant</h1>
              <p className="text-green-100 text-sm">
                {customer ? `👤 ${customer.name} · ${customer.phone}` : '● Online — Powered by Pine Labs'}
              </p>
            </div>
          </div>
        </div>

        {/* Messages */}
        <div className="h-96 overflow-y-auto p-4 space-y-3">
          {messages.map((msg, i) => (
            <div key={i} className={`flex ${msg.role === 'customer' ? 'justify-end' : 'justify-start'}`}>
              <div className={`max-w-xs px-4 py-2 rounded-2xl text-sm ${msg.role === 'customer'
                ? 'bg-green-600 text-white rounded-br-none'
                : 'bg-gray-100 text-gray-800 rounded-bl-none'
                }`}>
                {msg.paymentLink ? (
                  <div>
                    {/* Order Summary */}
                    {msg.orderItems && msg.orderItems.length > 0 && (
                      <div className="mb-3">
                        <p className="font-bold text-gray-700 mb-2">🧾 Order Summary</p>
                        <div className="bg-white rounded-xl p-3 space-y-1.5 border border-gray-200">
                          {msg.orderItems.map((item: OrderItem, idx: number) => (
                            <div key={idx} className="flex justify-between items-center text-xs">
                              <span className="text-gray-700">
                                {item.emoji} {item.quantity}× {item.name}
                              </span>
                              <span className="font-semibold text-gray-800">₹{item.subtotal_rupees}</span>
                            </div>
                          ))}
                          <div className="border-t border-dashed border-gray-300 pt-1.5 mt-1.5 flex justify-between items-center">
                            <span className="font-bold text-gray-800 text-xs">Total</span>
                            <span className="font-bold text-green-700 text-sm">₹{msg.orderTotal}</span>
                          </div>
                        </div>
                      </div>
                    )}
                    <a
                      href={msg.paymentLink}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="block w-full bg-green-600 text-white text-center py-2.5 px-4 rounded-xl font-bold hover:bg-green-700 transition-colors"
                    >
                      💳 Pay Now — ₹{msg.orderTotal || ''}
                    </a>
                  </div>
                ) : (
                  <p className="whitespace-pre-wrap break-words">
                    {msg.content.split('\n').map((line, lineIdx) => {
                      const urlRegex = /(https?:\/\/[^\s]+)/g
                      const parts = line.split(urlRegex)
                      return (
                        <span key={lineIdx}>
                          {parts.map((part, partIdx) =>
                            part.match(/^https?:\/\//) ? (
                              <a
                                key={partIdx}
                                href={part}
                                target="_blank"
                                rel="noopener noreferrer"
                                className={`underline font-medium break-all ${msg.role === 'customer' ? 'text-yellow-200' : 'text-blue-600'
                                  }`}
                              >
                                {part}
                              </a>
                            ) : (
                              <span key={partIdx}>{part}</span>
                            )
                          )}
                          {lineIdx < msg.content.split('\n').length - 1 && <br />}
                        </span>
                      )
                    })}
                  </p>
                )}
                {/* Only render timestamp if it exists — initial SSR message has none */}
                {msg.timestamp && (
                  <p className={`text-xs mt-1 ${msg.role === 'customer' ? 'text-green-200' : 'text-gray-600'}`}>
                    {msg.timestamp}
                  </p>
                )}
              </div>
            </div>
          ))}
          {loading && (
            <div className="flex justify-start">
              <div className="bg-gray-100 px-4 py-2 rounded-2xl rounded-bl-none">
                <div className="flex gap-1">
                  <span className="w-2 h-2 bg-gray-400 rounded-full animate-bounce"></span>
                  <span className="w-2 h-2 bg-gray-400 rounded-full animate-bounce delay-100"></span>
                  <span className="w-2 h-2 bg-gray-400 rounded-full animate-bounce delay-200"></span>
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Input */}
        <div className="p-4 border-t flex gap-2">
          <input
            type="text"
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && !loading && sendMessage()}
            placeholder={awaitingCustomerInfo ? 'Your name and phone...' : 'Type your order...'}
            className="flex-1 border rounded-full px-4 py-2 text-sm text-gray-800 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-green-500"
          />
          <button
            onClick={sendMessage}
            disabled={loading}
            className="bg-green-600 text-white rounded-full w-10 h-10 flex items-center justify-center hover:bg-green-700 disabled:opacity-50"
          >
            ➤
          </button>
        </div>
      </div>
    </div>
  )
}