import { NextResponse } from "next/server"
import { createClient } from "@/lib/neon/server"

export const dynamic = "force-dynamic"

// يُرجع ملخّصًا لكل رقم محدد: الاسم، رقم الجوال، تاريخ ووقت آخر رسالة،
// وصيغة (نوع) آخر رسالة واردة تم استلامها.
export async function POST(request: Request) {
  try {
    const body = await request.json()
    const phones: string[] = Array.isArray(body?.phones) ? body.phones : []

    if (phones.length === 0) {
      return NextResponse.json({ rows: [] }, { status: 200 })
    }

    const neonClient = await createClient()

    const { rows, error } = await neonClient.query(
      `
      WITH selected AS (
        SELECT DISTINCT REGEXP_REPLACE(UNNEST($1::text[]), '[^0-9]', '', 'g') AS normalized_phone
      ),
      incoming AS (
        SELECT
          REGEXP_REPLACE(from_number, '[^0-9]', '', 'g') AS normalized_phone,
          from_number,
          from_name,
          message_text,
          message_type,
          to_timestamp(timestamp) AS msg_time
        FROM webhook_messages
      ),
      outgoing AS (
        SELECT
          REGEXP_REPLACE(to_number, '[^0-9]', '', 'g') AS normalized_phone,
          to_number AS from_number,
          to_number AS from_name,
          message_text,
          message_type,
          created_at AS msg_time
        FROM message_history
      ),
      all_msgs AS (
        SELECT normalized_phone, from_number, from_name, msg_time FROM incoming
        UNION ALL
        SELECT normalized_phone, from_number, from_name, msg_time FROM outgoing
      ),
      last_overall AS (
        SELECT DISTINCT ON (normalized_phone)
          normalized_phone, from_number, from_name, msg_time
        FROM all_msgs
        ORDER BY normalized_phone, msg_time DESC
      ),
      last_incoming AS (
        SELECT DISTINCT ON (normalized_phone)
          normalized_phone,
          message_type AS last_incoming_type,
          message_text AS last_incoming_text,
          msg_time AS last_incoming_time
        FROM incoming
        ORDER BY normalized_phone, msg_time DESC
      )
      SELECT
        s.normalized_phone,
        COALESCE(lo.from_name, lo.from_number, s.normalized_phone) AS contact_name,
        COALESCE(lo.from_number, s.normalized_phone) AS phone_number,
        lo.msg_time AS last_message_time,
        li.last_incoming_type,
        li.last_incoming_text,
        li.last_incoming_time
      FROM selected s
      LEFT JOIN last_overall lo ON lo.normalized_phone = s.normalized_phone
      LEFT JOIN last_incoming li ON li.normalized_phone = s.normalized_phone
      ORDER BY lo.msg_time DESC NULLS LAST
      `,
      [phones],
    )

    if (error) {
      console.error("[v0] Error building export summary:", error)
      return NextResponse.json({ error: "Failed to build export summary" }, { status: 500 })
    }

    const result = (rows || []).map((r: any) => ({
      contact_name: r.contact_name,
      phone_number: r.phone_number,
      last_message_time: r.last_message_time ? new Date(r.last_message_time).toISOString() : null,
      last_received_type: r.last_incoming_type || null,
      last_received_text: r.last_incoming_text || null,
      last_received_time: r.last_incoming_time ? new Date(r.last_incoming_time).toISOString() : null,
    }))

    return NextResponse.json({ rows: result }, { status: 200 })
  } catch (error) {
    console.error("[v0] Unexpected error in export-summary:", error)
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 })
  }
}
