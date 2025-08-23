"use client"

import { useState, useEffect } from "react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { ArrowLeft, User, Mail, Loader2, Copy, CheckCircle, ExternalLink, Wallet } from "lucide-react"
import Link from "next/link"
import { useParams } from "next/navigation"

interface UserData {
  status: string
  username: string
  federationId: string
  nodeAlias: string
}

interface NostrEvent {
  id: string
  pubkey: string
  created_at: number
  kind: number
  tags: string[][]
  content: string
  sig: string
}

export default function UserPage() {
  const params = useParams()
  const pubkey = params.pubkey as string
  const [userData, setUserData] = useState<UserData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [npub, setNpub] = useState<string>("")
  const [copiedPubkey, setCopiedPubkey] = useState(false)
  const [copiedNpub, setCopiedNpub] = useState(false)
  const [copiedLightning, setCopiedLightning] = useState(false)
  const [balance, setBalance] = useState<number | null>(null)
  const [balanceLoading, setBalanceLoading] = useState(false)
  const [balanceError, setBalanceError] = useState<string | null>(null)

  const bech32Encode = (hrp: string, data: Uint8Array): string => {
    const CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l"
    const BECH32_CONST = 1

    const convertBits = (data: Uint8Array, fromBits: number, toBits: number, pad: boolean): number[] => {
      let acc = 0
      let bits = 0
      const ret: number[] = []
      const maxv = (1 << toBits) - 1
      const maxAcc = (1 << (fromBits + toBits - 1)) - 1

      for (const value of data) {
        if (value < 0 || value >> fromBits !== 0) {
          throw new Error("Invalid data for base conversion")
        }
        acc = ((acc << fromBits) | value) & maxAcc
        bits += fromBits
        while (bits >= toBits) {
          bits -= toBits
          ret.push((acc >> bits) & maxv)
        }
      }

      if (pad) {
        if (bits > 0) {
          ret.push((acc << (toBits - bits)) & maxv)
        }
      } else if (bits >= fromBits || ((acc << (toBits - bits)) & maxv) !== 0) {
        throw new Error("Invalid padding in base conversion")
      }

      return ret
    }

    const bech32Polymod = (values: number[]): number => {
      const GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3]
      let chk = 1
      for (const value of values) {
        const top = chk >> 25
        chk = ((chk & 0x1ffffff) << 5) ^ value
        for (let i = 0; i < 5; i++) {
          chk ^= (top >> i) & 1 ? GEN[i] : 0
        }
      }
      return chk
    }

    const bech32CreateChecksum = (hrp: string, data: number[]): number[] => {
      const hrpExpanded = []
      for (let i = 0; i < hrp.length; i++) {
        hrpExpanded.push(hrp.charCodeAt(i) >> 5)
      }
      hrpExpanded.push(0)
      for (let i = 0; i < hrp.length; i++) {
        hrpExpanded.push(hrp.charCodeAt(i) & 31)
      }
      const polymod = bech32Polymod(hrpExpanded.concat(data).concat([0, 0, 0, 0, 0, 0])) ^ BECH32_CONST
      const checksum = []
      for (let i = 0; i < 6; i++) {
        checksum.push((polymod >> (5 * (5 - i))) & 31)
      }
      return checksum
    }

    try {
      const converted = convertBits(data, 8, 5, true)
      const checksum = bech32CreateChecksum(hrp, converted)
      const combined = converted.concat(checksum)
      let ret = hrp + "1"
      for (const d of combined) {
        ret += CHARSET[d]
      }
      return ret
    } catch (err) {
      throw new Error("Bech32 encoding failed")
    }
  }

  // Convert hex pubkey to npub format using proper bech32 encoding
  const hexToNpub = (hex: string): string => {
    try {
      // Remove 0x prefix if present
      const cleanHex = hex.startsWith("0x") ? hex.slice(2) : hex

      // Convert hex to bytes
      const bytes = new Uint8Array(cleanHex.length / 2)
      for (let i = 0; i < cleanHex.length; i += 2) {
        bytes[i / 2] = Number.parseInt(cleanHex.substr(i, 2), 16)
      }

      // Encode as bech32 with 'npub' prefix
      return bech32Encode("npub", bytes)
    } catch (err) {
      console.error("Error converting hex to npub:", err)
      return "Invalid pubkey"
    }
  }

  const copyToClipboard = async (text: string, type: "pubkey" | "npub" | "lightning") => {
    try {
      await navigator.clipboard.writeText(text)
      if (type === "pubkey") {
        setCopiedPubkey(true)
        setTimeout(() => setCopiedPubkey(false), 2000)
      } else if (type === "npub") {
        setCopiedNpub(true)
        setTimeout(() => setCopiedNpub(false), 2000)
      } else if (type === "lightning") {
        setCopiedLightning(true)
        setTimeout(() => setCopiedLightning(false), 2000)
      }
    } catch (err) {
      console.error("Failed to copy:", err)
    }
  }

  const queryUserBalance = async (userPubkey: string) => {
    setBalanceLoading(true)
    setBalanceError(null)

    try {
      const ws = new WebSocket("wss://relay.lawallet.ar")

      return new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
          ws.close()
          reject(new Error("Query timeout"))
        }, 10000)

        ws.onopen = () => {
          console.log("[v0] Connected to relay for balance query")

          // Create filter for specific user balance
          const filter = {
            kinds: [31111],
            "#d": [`balance:BTC:${userPubkey}`],
          }

          const subscription = ["REQ", "balance_query", filter]
          ws.send(JSON.stringify(subscription))
        }

        ws.onmessage = (event) => {
          try {
            const message = JSON.parse(event.data)
            console.log("[v0] Received message:", message)

            if (message[0] === "EVENT" && message[2]) {
              const nostrEvent: NostrEvent = message[2]

              // Parse the event to get balance
              const amountTag = nostrEvent.tags.find((tag) => tag[0] === "amount")
              if (amountTag && amountTag[1]) {
                const amountInMillisats = Number.parseInt(amountTag[1])
                const amountInSats = amountInMillisats / 1000
                setBalance(amountInSats)
                console.log("[v0] Found balance:", amountInSats, "sats")
              }
            } else if (message[0] === "EOSE") {
              // End of stored events
              console.log("[v0] End of stored events")
              clearTimeout(timeout)
              ws.close()
              resolve()
            }
          } catch (err) {
            console.error("[v0] Error parsing message:", err)
          }
        }

        ws.onerror = (error) => {
          console.error("[v0] WebSocket error:", error)
          clearTimeout(timeout)
          reject(new Error("WebSocket connection failed"))
        }

        ws.onclose = () => {
          console.log("[v0] WebSocket closed")
          clearTimeout(timeout)
        }
      })
    } catch (err) {
      console.error("[v0] Error querying balance:", err)
      setBalanceError(err instanceof Error ? err.message : "Failed to query balance")
    } finally {
      setBalanceLoading(false)
    }
  }

  useEffect(() => {
    const fetchUserData = async () => {
      if (!pubkey) return

      setLoading(true)
      setError(null)

      try {
        // Convert pubkey to npub format
        const npubValue = hexToNpub(pubkey)
        setNpub(npubValue)

        // Fetch user data from LaWallet API
        const response = await fetch(`https://lawallet.ar/api/pubkey/${pubkey}`)

        if (!response.ok) {
          throw new Error(`Failed to fetch user data: ${response.status}`)
        }

        const data: UserData = await response.json()

        if (data.status !== "OK") {
          throw new Error("User not found or invalid response")
        }

        setUserData(data)

        await queryUserBalance(pubkey)
      } catch (err) {
        console.error("Error fetching user data:", err)
        setError(err instanceof Error ? err.message : "Failed to fetch user data")
      } finally {
        setLoading(false)
      }
    }

    fetchUserData()
  }, [pubkey])

  if (!pubkey) {
    return (
      <div className="min-h-screen gradient-bg p-4">
        <div className="max-w-2xl mx-auto">
          <Card>
            <CardContent className="pt-6">
              <p className="text-center text-muted-foreground">Invalid user ID</p>
            </CardContent>
          </Card>
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-screen gradient-bg p-4">
      <div className="max-w-2xl mx-auto space-y-6">
        {/* Header with back button */}
        <div className="flex items-center gap-4 animate-slide-up">
          <Link href="/">
            <Button variant="outline" size="sm" className="hover:scale-105 transition-transform bg-transparent">
              <ArrowLeft className="h-4 w-4 mr-2" />
              Back to Audit
            </Button>
          </Link>
          <div>
            <h1 className="text-2xl font-bold bg-gradient-to-r from-primary to-accent bg-clip-text text-transparent">
              User Details
            </h1>
            <p className="text-muted-foreground text-sm">LaWallet user information</p>
          </div>
        </div>

        <Card className="animate-fade-in border-2 hover:border-primary/20 transition-all duration-300">
          <CardHeader className="bg-gradient-to-r from-primary/5 to-accent/5 rounded-t-lg">
            <CardTitle className="flex items-center gap-2">
              <Wallet className="h-5 w-5 text-primary" />
              Current Balance
            </CardTitle>
            <CardDescription>Real-time balance from nostr relay</CardDescription>
          </CardHeader>
          <CardContent className="pt-6">
            {balanceLoading ? (
              <div className="flex items-center justify-center py-4">
                <Loader2 className="h-6 w-6 animate-spin text-primary" />
                <span className="ml-2 text-muted-foreground">Querying balance...</span>
              </div>
            ) : balanceError ? (
              <div className="text-center py-4">
                <p className="text-destructive text-sm">{balanceError}</p>
                <Badge variant="secondary" className="mt-2">
                  Balance unavailable
                </Badge>
              </div>
            ) : balance !== null ? (
              <div className="text-center py-2">
                <div className="text-3xl font-bold bg-gradient-to-r from-primary to-accent bg-clip-text text-transparent">
                  {balance.toLocaleString()} sats
                </div>
                <p className="text-sm text-muted-foreground mt-1">≈ {(balance / 100000000).toFixed(8)} BTC</p>
              </div>
            ) : (
              <div className="text-center py-4">
                <Badge variant="secondary">No balance found</Badge>
              </div>
            )}
          </CardContent>
        </Card>

        {/* User Info Card */}
        <Card className="animate-fade-in border-2 hover:border-primary/20 transition-all duration-300">
          <CardHeader className="bg-gradient-to-r from-primary/5 to-accent/5 rounded-t-lg">
            <CardTitle className="flex items-center gap-2">
              <User className="h-5 w-5 text-primary" />
              User Information
            </CardTitle>
            <CardDescription>Details for this LaWallet user</CardDescription>
          </CardHeader>
          <CardContent className="pt-6 space-y-6">
            {loading ? (
              <div className="flex items-center justify-center py-8">
                <Loader2 className="h-8 w-8 animate-spin text-primary" />
                <span className="ml-2 text-muted-foreground">Loading user data...</span>
              </div>
            ) : error ? (
              <div className="text-center py-8">
                <p className="text-destructive mb-4">{error}</p>
                <Badge variant="secondary">User not found in LaWallet</Badge>
              </div>
            ) : userData ? (
              <div className="space-y-4">
                {/* Lightning Address */}
                <div className="p-4 bg-gradient-to-r from-accent/10 to-accent/5 rounded-lg border-2 border-accent/20">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <Mail className="h-5 w-5 text-accent" />
                      <span className="font-medium">Lightning Address</span>
                    </div>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => copyToClipboard(`${userData.username}@${userData.federationId}`, "lightning")}
                      className="hover:bg-accent/10"
                    >
                      {copiedLightning ? (
                        <CheckCircle className="h-4 w-4 text-green-500" />
                      ) : (
                        <Copy className="h-4 w-4" />
                      )}
                    </Button>
                  </div>
                  <p className="text-xl font-mono font-bold text-accent mt-2">
                    {userData.username}@{userData.federationId}
                  </p>
                </div>

                {/* User Details Grid */}
                <div className="grid gap-4">
                  <div className="p-4 bg-muted/30 rounded-lg">
                    <div className="flex justify-between items-center">
                      <span className="text-sm font-medium text-muted-foreground">Username</span>
                      <Badge variant="outline" className="font-mono">
                        {userData.username}
                      </Badge>
                    </div>
                  </div>

                  <div className="p-4 bg-muted/30 rounded-lg">
                    <div className="flex justify-between items-center">
                      <span className="text-sm font-medium text-muted-foreground">Federation</span>
                      <Badge variant="outline" className="font-mono">
                        {userData.federationId}
                      </Badge>
                    </div>
                  </div>

                  <div className="p-4 bg-muted/30 rounded-lg">
                    <div className="flex justify-between items-center">
                      <span className="text-sm font-medium text-muted-foreground">Node Alias</span>
                      <Badge variant="outline" className="font-mono">
                        {userData.nodeAlias}
                      </Badge>
                    </div>
                  </div>
                </div>
              </div>
            ) : null}
          </CardContent>
        </Card>

        {/* Technical Details Card */}
        <Card
          className="animate-fade-in border-2 hover:border-primary/20 transition-all duration-300"
          style={{ animationDelay: "0.1s" }}
        >
          <CardHeader className="bg-gradient-to-r from-primary/5 to-accent/5 rounded-t-lg">
            <CardTitle className="flex items-center gap-2">
              <ExternalLink className="h-5 w-5 text-primary" />
              Technical Details
            </CardTitle>
            <CardDescription>Nostr and cryptographic identifiers</CardDescription>
          </CardHeader>
          <CardContent className="pt-6 space-y-4">
            {/* Public Key */}
            <div className="p-4 bg-muted/30 rounded-lg">
              <div className="flex items-center justify-between mb-2">
                <span className="text-sm font-medium text-muted-foreground">Public Key (Hex)</span>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => copyToClipboard(pubkey, "pubkey")}
                  className="hover:bg-muted/50"
                >
                  {copiedPubkey ? <CheckCircle className="h-4 w-4 text-green-500" /> : <Copy className="h-4 w-4" />}
                </Button>
              </div>
              <code className="text-xs bg-muted/50 px-2 py-1 rounded font-mono break-all block">{pubkey}</code>
            </div>

            {/* NPub */}
            <div className="p-4 bg-muted/30 rounded-lg">
              <div className="flex items-center justify-between mb-2">
                <span className="text-sm font-medium text-muted-foreground">NPub (Bech32)</span>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => copyToClipboard(npub, "npub")}
                  className="hover:bg-muted/50"
                >
                  {copiedNpub ? <CheckCircle className="h-4 w-4 text-green-500" /> : <Copy className="h-4 w-4" />}
                </Button>
              </div>
              <code className="text-xs bg-muted/50 px-2 py-1 rounded font-mono break-all block">{npub}</code>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
