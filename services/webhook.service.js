/**
 * N8N & External Automation Webhook Dispatcher
 * Dispatches event payloads to N8N.cloud workflows
 */

const getFrontendBaseUrl = () => {
  const url = process.env.FRONTEND_URL || process.env.VITE_PUBLIC_APP_URL || process.env.PUBLIC_APP_URL || 'https://nexus-fms.netlify.app';
  return url.replace(/\/$/, '');
};

const dispatchN8NWebhook = async (eventType, payload) => {
  const n8nWebhookUrl = process.env.N8N_WEBHOOK_URL;

  let formattedPayload = payload ? { ...payload } : {};

  if (eventType === 'TASK_ASSIGNED') {
    const frontendBase = getFrontendBaseUrl();
    const workOrderId = formattedPayload.workOrderId || formattedPayload.entityId || formattedPayload.relatedEntityId || null;

    // 1. Direct frontend URL where technician can open the assigned job details
    if (workOrderId) {
      formattedPayload.actionUrl = `${frontendBase}/jobs/${workOrderId}`;
    } else if (!formattedPayload.actionUrl || !formattedPayload.actionUrl.startsWith('http')) {
      formattedPayload.actionUrl = `${frontendBase}/maintenance/my-tasks`;
    }

    // 2. Ensure entityId and workOrderId
    if (workOrderId) {
      formattedPayload.entityId = formattedPayload.entityId || workOrderId;
      formattedPayload.workOrderId = formattedPayload.workOrderId || workOrderId;
    }

    // 3. Ensure technicianName & technicianPhone
    formattedPayload.technicianName = formattedPayload.technicianName || formattedPayload.technician?.name || null;
    formattedPayload.technicianPhone = formattedPayload.technicianPhone || formattedPayload.technician?.phone || formattedPayload.contactPhone || null;

    // 4. Ensure propertyAddress
    formattedPayload.propertyAddress = formattedPayload.propertyAddress || formattedPayload.address || null;

    // 5. Ensure title
    formattedPayload.title = formattedPayload.title || 'New task assigned';

    // 6. Ensure message
    if (!formattedPayload.message) {
      const jobDesc = formattedPayload.title || `Work Order #${workOrderId || ''}`;
      const addrDesc = formattedPayload.propertyAddress ? ` at ${formattedPayload.propertyAddress}` : '';
      formattedPayload.message = `New task assigned: ${jobDesc}${addrDesc}`;
    }
  }

  const eventData = {
    event: eventType,
    timestamp: new Date().toISOString(),
    source: 'nexus_fms_backend',
    data: formattedPayload,
  };

  if (!n8nWebhookUrl) {
    console.log(`[N8N_WEBHOOK_DEV] 📡 Event "${eventType}" ready. (Set N8N_WEBHOOK_URL in .env to dispatch live)`);
    return { success: true, mode: 'mock', event: eventType };
  }

  try {
    console.log(`[N8N_WEBHOOK] 🚀 Dispatching "${eventType}" to ${n8nWebhookUrl}`);
    
    const response = await fetch(n8nWebhookUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Nexus-Event': eventType,
        'X-Nexus-Secret': process.env.WEBHOOK_SECRET_KEY || 'nexus-secret',
      },
      body: JSON.stringify(eventData),
    });

    if (!response.ok) {
      console.warn(`[N8N_WEBHOOK] ⚠ N8N returned status ${response.status}`);
      return { success: false, status: response.status };
    }

    const resJson = await response.json().catch(() => ({}));
    console.log(`[N8N_WEBHOOK] ✓ Event "${eventType}" successfully delivered to N8N`);
    return { success: true, data: resJson };
  } catch (err) {
    console.error(`[N8N_WEBHOOK_ERROR] ❌ Failed to send webhook for "${eventType}":`, err.message);
    return { success: false, error: err.message };
  }
};

module.exports = {
  dispatchN8NWebhook,
};
