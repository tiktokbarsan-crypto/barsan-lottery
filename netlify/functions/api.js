const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL || "https://ujvnuhlcpspojzfnkfxs.supabase.co";
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
const ADMIN_TELEGRAM_ID = 6657645905;

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

const response = (statusCode, body) => ({
    statusCode,
    headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "Content-Type",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS"
    },
    body: JSON.stringify(body)
});

exports.handler = async (event, context) => {
    if (event.httpMethod === "OPTIONS") return response(200, { message: "Ping OK" });

    const path = event.path.split('/').pop();
    const body = event.body ? JSON.parse(event.body) : {};

    try {
        switch (path) {
            case 'authTelegram':
                return await handleAuthTelegram(body);
            case 'createOrder':
                return await handleCreateOrder(body);
            case 'verifyPaymentWebhook':
                return await handleVerifyPaymentWebhook(body);
            case 'getNumbers':
                return await handleGetNumbers();
            case 'claimReferralReward':
                return await handleClaimReferralReward(body);
            case 'getWinners':
                return await handleGetWinners();
            case 'selectWinner':
                return await handleSelectWinner(body);
            default:
                return response(404, { error: `Endpoint /${path} Not Found` });
        }
    } catch (err) {
        console.error("Runtime Error:", err);
        return response(500, { error: err.message });
    }
};

async function handleAuthTelegram({ telegram_id, username, referral_code_used }) {
    if (!telegram_id) return response(400, { error: "Missing Telegram ID" });
    
    let { data: user } = await supabase
        .from('users')
        .select('*')
        .eq('telegram_id', telegram_id)
        .single();

    if (!user) {
        const uniqueRefCode = Math.random().toString(36).substring(2, 8).toUpperCase();
        const { data: newUser, error: createError } = await supabase
            .from('users')
            .insert([{ 
                telegram_id, 
                username, 
                referral_code: uniqueRefCode,
                free_tickets_balance: 0 
            }])
            .select()
            .single();

        if (createError) throw createError;
        user = newUser;

        if (referral_code_used && referral_code_used !== uniqueRefCode) {
            const { data: inviter } = await supabase
                .from('users')
                .select('telegram_id')
                .eq('referral_code', referral_code_used)
                .single();

            if (inviter) {
                await supabase.from('referrals').insert([{
                    inviter_id: inviter.telegram_id,
                    invited_id: telegram_id,
                    reward_status: 'pending'
                }]);
            }
        }
    }
    return response(200, user);
}

async function handleCreateOrder({ telegram_id, numbers, transaction_ref }) {
    if (!telegram_id || !Array.isArray(numbers) || numbers.length === 0) {
        return response(400, { error: "Invalid parameters" });
    }
    if (numbers.length > 2) return response(400, { error: "Max 2 tickets per round" });

    const { data: existingOrders } = await supabase
        .from('orders')
        .select('numbers_selected')
        .eq('user_id', telegram_id)
        .eq('status', 'paid');
    
    const countPaid = existingOrders ? existingOrders.reduce((acc, o) => acc + o.numbers_selected.length, 0) : 0;
    if (countPaid + numbers.length > 2) {
        return response(400, { error: "Purchase limits exceeded. Max 2 tickets allowed total." });
    }

    const { data: unavailable } = await supabase
        .from('numbers')
        .select('number')
        .eq('round_number', 1)
        .in('number', numbers)
        .neq('status', 'available');

    if (unavailable && unavailable.length > 0) {
        return response(400, { error: `Numbers already taken: ${unavailable.map(n => n.number).join(', ')}` });
    }

    const { data: order, error: orderErr } = await supabase
        .from('orders')
        .insert([{
            user_id: telegram_id,
            numbers_selected: numbers,
            amount: numbers.length * 200,
            transaction_ref: transaction_ref || null,
            status: 'pending'
        }])
        .select()
        .single();

    if (orderErr) throw orderErr;
    return response(200, { message: "Order created successfully", order });
}

async function handleVerifyPaymentWebhook({ from, message }) {
    if (!message) return response(400, { error: "Empty message payload" });

    const amountRegex = /(?:ETB|Amount:?)\s*([\d,.]+)/i;
    const refRegex = /(?:Ref|Reference|TxnID):?\s*([A-Z0-9]+)/i;

    const amountMatch = message.match(amountRegex);
    const refMatch = message.match(refRegex);

    if (!amountMatch || !refMatch) {
        return response(422, { error: "SMS format unparseable" });
    }

    const parsedAmount = parseFloat(amountMatch[1].replace(/,/g, ''));
    const txnId = refMatch[1].trim();

    const { data: paymentLog, error: payErr } = await supabase
        .from('payments')
        .insert([{ amount: parsedAmount, transaction_id: txnId, sms_text: message, verified: false }])
        .select()
        .single();

    if (payErr) return response(409, { error: "Duplicate transaction processed." });

    const { data: targetOrder } = await supabase
        .from('orders')
        .select('*')
        .eq('status', 'pending')
        .eq('amount', parsedAmount)
        .eq('transaction_ref', txnId)
        .single();

    if (targetOrder) {
        await supabase.from('orders').update({ status: 'paid' }).eq('id', targetOrder.id);
        await supabase.from('payments').update({ verified: true, order_id: targetOrder.id }).eq('id', paymentLog.id);

        await supabase.from('numbers')
            .update({ status: 'sold', owner_id: targetOrder.user_id })
            .eq('round_number', 1)
            .in('number', targetOrder.numbers_selected);

        const { data: refRelation } = await supabase
            .from('referrals')
            .select('*')
            .eq('invited_id', targetOrder.user_id)
            .eq('reward_status', 'pending')
            .single();

        if (refRelation) {
            const { data: inviterUser } = await supabase
                .from('users')
                .select('free_tickets_balance')
                .eq('telegram_id', refRelation.inviter_id)
                .single();

            if (inviterUser) {
                await supabase.from('users')
                    .update({ free_tickets_balance: inviterUser.free_tickets_balance + 1 })
                    .eq('telegram_id', refRelation.inviter_id);

                await supabase.from('referrals')
                    .update({ reward_status: 'rewarded' })
                    .eq('id', refRelation.id);
            }
        }
        return response(200, { success: true, message: "Payment matched and order completed!" });
    }
    return response(200, { success: false, message: "SMS logged but no matching pending order found." });
}

async function handleGetNumbers() {
    const { data, error } = await supabase
        .from('numbers')
        .select('number, status, owner_id')
        .eq('round_number', 1)
        .order('number', { ascending: true });

    if (error) throw error;
    return response(200, data);
}

async function handleClaimReferralReward({ telegram_id }) {
    const { data: user } = await supabase
        .from('users')
        .select('free_tickets_balance')
        .eq('telegram_id', telegram_id)
        .single();

    if (!user || user.free_tickets_balance < 1) {
        return response(400, { error: "No rewards available." });
    }

    const { data: randomAvailable } = await supabase
        .from('numbers')
        .select('number')
        .eq('round_number', 1)
        .eq('status', 'available')
        .limit(1)
        .single();

    if (!randomAvailable) return response(400, { error: "No numbers left to claim." });

    await supabase.from('users').update({ free_tickets_balance: user.free_tickets_balance - 1 }).eq('telegram_id', telegram_id);
    await supabase.from('numbers').update({ status: 'sold', owner_id: telegram_id }).eq('round_number', 1).eq('number', randomAvailable.number);

    return response(200, { success: true, claimed_number: randomAvailable.number });
}

async function handleGetWinners() {
    const { data, error } = await supabase
        .from('winners')
        .select('*')
        .order('round_number', { ascending: false });

    if (error) throw error;
    return response(200, data);
}

async function handleSelectWinner({ admin_id, round_number }) {
    if (Number(admin_id) !== ADMIN_TELEGRAM_ID) {
        return response(403, { error: "Access denied" });
    }

    const { data: soldTickets } = await supabase
        .from('numbers')
        .select('number, owner_id')
        .eq('round_number', round_number)
        .eq('status', 'sold');

    if (!soldTickets || soldTickets.length < 3) {
        return response(400, { error: "Need at least 3 tickets sold to pick winners." });
    }

    const pool = [...soldTickets].sort(() => Math.random() - 0.5);
    
    const { data: drawResult, error } = await supabase
        .from('winners')
        .insert([{
            round_number,
            first_place: pool[0].owner_id,
            second_place: pool[1].owner_id,
            third_place: pool[2].owner_id
        }])
        .select()
        .single();

    if (error) throw error;
    return response(200, { message: "Draw complete!", drawResult });
}
  
