#!/usr/bin/env bash
# End-to-end production smoke test (Phase 25 scenario).
# Requires the production server running on $PORT with SESSION_SECRET set.
# GEMINI_API_KEY may be absent — generate-config/simulate then return graceful
# fallbacks, which still proves the wiring works.
set -u
PORT="${PORT:-3999}"
BASE="http://127.0.0.1:$PORT"
COOKIE=/tmp/e2e-cookies.txt
rm -f "$COOKIE"
pass=0; fail=0
check() {
  if [ "$2" = "$3" ]; then echo "PASS  $1 ($2)"; pass=$((pass+1));
  else echo "FAIL  $1 (got '$2' want '$3')"; fail=$((fail+1)); fi
}
jp() { python3 -c "import sys,json; d=json.load(sys.stdin); print(d$1)" 2>/dev/null; }

echo "=== 1. LOGIN platform owner ==="
r=$(curl -s -c "$COOKIE" -X POST "$BASE/api/auth/login" -H "Content-Type: application/json" \
  -d '{"email":"owner@agentfactory.io","password":"Password123!"}')
check "login" "$(echo "$r" | jp "['user']['role']")" "PLATFORM_OWNER"

echo "=== 2. CREATE BUSINESS (E2E Barber) ==="
r=$(curl -s -b "$COOKIE" -X POST "$BASE/api/businesses" -H "Content-Type: application/json" \
  -d '{"name":"E2E Barber","type":"barbershop","description":"e2e","location":"town","services":[{"name":"Haircut","price":20000,"durationMinutes":30,"description":"cut"}],"faqs":[]}')
BID=$(echo "$r" | jp "['id']")
check "business created" "${BID:0:4}" "biz-"
SID=$(echo "$r" | jp "['services'][0]['id']")

echo "=== 3. GENERATE AGENT CONFIG (needs business name+type) ==="
r=$(curl -s -b "$COOKIE" -X POST "$BASE/api/agents/generate-config" -H "Content-Type: application/json" \
  -d "{\"name\":\"E2E Barber\",\"type\":\"barbershop\",\"description\":\"e2e\"}")
check "gen returns agentName" "$(echo "$r" | jp "['agentName']" | head -c1 | tr -d '\n' | wc -c)" "1"

echo "=== 4. CREATE AGENT (default tools include booking) ==="
r=$(curl -s -b "$COOKIE" -X POST "$BASE/api/agents" -H "Content-Type: application/json" \
  -d "{\"businessId\":\"$BID\",\"name\":\"E2E Assistant\",\"description\":\"e2e\"}")
AID=$(echo "$r" | jp "['id']")
check "agent created" "${AID:0:6}" "agent-"
check "agent has book_appointment tool" "$(echo "$r" | jp "['structuredConfig']['toolsEnabled']" | grep -c book_appointment)" "1"

echo "=== 5. ADD KNOWLEDGE ==="
r=$(curl -s -b "$COOKIE" -X POST "$BASE/api/knowledge" -H "Content-Type: application/json" \
  -d "{\"businessId\":\"$BID\",\"title\":\"Hours\",\"type\":\"faq\",\"content\":\"We are open Mon-Sat 9-18.\",\"tags\":[]}")
check "knowledge created" "$(echo "$r" | jp "['id']" | head -c1 | tr -d '\n' | wc -c)" "1"

echo "=== 6. TEST AGENT (simulator, businessId-scoped) ==="
r=$(curl -s -b "$COOKIE" -X POST "$BASE/api/runtime/simulate" -H "Content-Type: application/json" \
  -d "{\"businessId\":\"$BID\",\"userMessage\":\"What are your hours?\"}")
check "simulate returns reply" "$(echo "$r" | jp "['reply']" | head -c1 | tr -d '\n' | wc -c)" "1"

echo "=== 7. BOOK APPOINTMENT (near-term weekday) ==="
DATE=$(python3 -c "import datetime; d=datetime.date.today()+datetime.timedelta(days=1); [d:=d+datetime.timedelta(days=1) for _ in iter(lambda: d.weekday()!=6, None)]; print(d.isoformat())" 2>/dev/null || python3 -c "
import datetime
d=datetime.date.today()+datetime.timedelta(days=1)
while d.weekday()==6: d+=datetime.timedelta(days=1)
print(d.isoformat())")
r=$(curl -s -b "$COOKIE" -X POST "$BASE/api/appointments" -H "Content-Type: application/json" \
  -d "{\"businessId\":\"$BID\",\"serviceId\":\"$SID\",\"customerName\":\"Sam\",\"customerPhone\":\"+1\",\"date\":\"$DATE\",\"startTime\":\"10:00\"}")
APPT=$(echo "$r" | jp "['id']")
check "booked 201" "$(echo "$r" | python3 -c 'import sys,json;print("ok" if json.load(sys.stdin).get("id") else "ERR")')" "ok"

echo "=== 8. VERIFY DATABASE (appointment persisted) ==="
r=$(curl -s -b "$COOKIE" "$BASE/api/appointments?businessId=$BID")
COUNT=$(echo "$r" | python3 -c "import sys,json;print(len(json.load(sys.stdin)))")
check "appointment in DB" "$COUNT" "1"

echo "=== 9. CANCEL APPOINTMENT (mass-assignment guard) ==="
r=$(curl -s -b "$COOKIE" -X PUT "$BASE/api/appointments/$APPT" -H "Content-Type: application/json" \
  -d "{\"status\":\"CANCELLED\",\"businessId\":\"biz-tonys-barber\",\"id\":\"forged\"}")
check "cancelled" "$(echo "$r" | jp "['status']")" "CANCELLED"
check "businessId NOT overwritten (mass-assign guard)" "$(echo "$r" | jp "['businessId']")" "$BID"
check "id NOT overwritten" "$(echo "$r" | jp "['id']")" "$APPT"

echo "=== 10. PUBLISH + ACTIVATE AGENT ==="
# The initial draft was created at agent creation; publish THAT draft.
DRAFT_VID=$(curl -s -b "$COOKIE" "$BASE/api/agents/$AID/versions" | python3 -c "import sys,json;print([v for v in json.load(sys.stdin) if v['status']=='DRAFT'][0]['id'])")
r=$(curl -s -b "$COOKIE" -X POST "$BASE/api/agents/$AID/versions/$DRAFT_VID/publish" -H "Content-Type: application/json")
check "published" "$(echo "$r" | jp "['status']")" "PUBLISHED"
r=$(curl -s -b "$COOKIE" -X POST "$BASE/api/agents/$AID/status" -H "Content-Type: application/json" -d '{"status":"ACTIVE"}')
check "active" "$(echo "$r" | jp "['status']")" "ACTIVE"

echo "=== 11. WIDGET CHAT from allowed origin ==="
curl -s -b "$COOKIE" -X PUT "$BASE/api/businesses/$BID" -H "Content-Type: application/json" -d '{"allowedWidgetOrigins":["https://e2e.example"]}' >/dev/null
r=$(curl -s -X POST "$BASE/api/runtime/chat" -H "Origin: https://e2e.example" -H "Content-Type: application/json" \
  -d "{\"tenantId\":\"$BID\",\"userMessage\":\"hello\"}")
check "widget chat returns conversation" "$(echo "$r" | jp "['conversationId']" | head -c1 | tr -d '\n' | wc -c)" "1"

echo "=== 12. WIDGET CHAT from DISALLOWED origin (403) ==="
r=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE/api/runtime/chat" -H "Origin: https://evil.example" -H "Content-Type: application/json" -d "{\"tenantId\":\"$BID\",\"userMessage\":\"hi\"}")
check "disallowed origin 403" "$r" "403"

echo "=== 13. TENANT ISOLATION: Tony cannot read E2E Barber ==="
TCOOKIE=/tmp/e2e-tony.txt; rm -f "$TCOOKIE"
curl -s -c "$TCOOKIE" -X POST "$BASE/api/auth/login" -H "Content-Type: application/json" \
  -d '{"email":"tony@tonysbarber.com","password":"Password123!"}' >/dev/null
# Tony requests E2E's appointments by supplying E2E's businessId. requireTenantScope
# must reject the cross-tenant request (404) — Tony never sees E2E's appointments.
r=$(curl -s -b "$TCOOKIE" "$BASE/api/appointments?businessId=$BID")
check "tony cannot read E2E appts (isolated)" "$(echo "$r" | python3 -c 'import sys,json; d=json.load(sys.stdin); print("isolated" if d.get("error") or (isinstance(d,list) and len(d)==0) else "LEAK")')" "isolated"
# Tony also cannot read E2E's business config.
r=$(curl -s -b "$TCOOKIE" "$BASE/api/businesses/$BID")
check "tony cannot read E2E business (404/403)" "$(echo "$r" | python3 -c 'import sys,json;d=json.load(sys.stdin);print("denied" if d.get("error") else "LEAK")')" "denied"

echo ""
echo "=========================================="
echo "E2E RESULT: $pass passed, $fail failed"
echo "=========================================="
exit $fail
