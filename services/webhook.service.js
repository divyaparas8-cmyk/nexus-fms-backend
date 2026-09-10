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

  if (eventType === 'TASK_REASSIGNED' || eventType === 'TASK_UNASSIGNED') {
    const frontendBase = getFrontendBaseUrl();
    const workOrderId = formattedPayload.workOrderId || formattedPayload.entityId || formattedPayload.relatedEntityId || null;

    if (workOrderId) {
      formattedPayload.entityId = formattedPayload.entityId || workOrderId;
      formattedPayload.workOrderId = formattedPayload.workOrderId || workOrderId;
    }
    if (!formattedPayload.actionUrl) {
      formattedPayload.actionUrl = `${frontendBase}/maintenance/my-tasks`;
    }

    formattedPayload.technicianName = formattedPayload.technicianName || formattedPayload.technician?.name || formattedPayload.previousTechnician?.name || null;
    formattedPayload.technicianPhone = formattedPayload.technicianPhone || formattedPayload.technician?.phone || formattedPayload.previousTechnician?.phone || formattedPayload.contactPhone || null;
    formattedPayload.propertyAddress = formattedPayload.propertyAddress || formattedPayload.address || null;
    formattedPayload.title = formattedPayload.title || 'Task Reassigned to Another Technician';

    if (!formattedPayload.message) {
      const jobDesc = formattedPayload.jobNumber ? `Job #${formattedPayload.jobNumber}` : (formattedPayload.title || `Work Order #${workOrderId || ''}`);
      const addrDesc = formattedPayload.propertyAddress ? ` at ${formattedPayload.propertyAddress}` : '';
      formattedPayload.message = `${jobDesc}${addrDesc} has been reassigned to another technician. You are relieved from this task.`;
    }
  }

  if (eventType === 'QUOTE_PHOTO_REQUEST' || eventType === 'NEW_QUOTE_REQUEST') {
    const frontendBase = getFrontendBaseUrl();
    const workOrderId = formattedPayload.workOrderId || formattedPayload.entityId || formattedPayload.relatedEntityId || null;
    let token = formattedPayload.secureToken || formattedPayload.data?.secure_token || null;

    if (!token && workOrderId) {
      try {
        const { pool } = require('../config/db');
        const [qrRows] = await pool.query(
          'SELECT secure_token FROM quote_requests WHERE work_order_id = ? ORDER BY created_at DESC LIMIT 1',
          [workOrderId]
        );
        if (qrRows.length > 0) token = qrRows[0].secure_token;
      } catch (e) {
        // ignore
      }
    }

    if (token) {
      const uploadUrl = `${frontendBase}/quote-request/${token}`;
      formattedPayload.actionUrl = uploadUrl;
      formattedPayload.uploadUrl = uploadUrl;
      formattedPayload.photoUploadLink = uploadUrl;
      formattedPayload.secureToken = token;
      if (formattedPayload.data) {
        formattedPayload.data.actionUrl = uploadUrl;
        formattedPayload.data.uploadUrl = uploadUrl;
        formattedPayload.data.photoUploadLink = uploadUrl;
        formattedPayload.data.uploadLink = uploadUrl;
        formattedPayload.data.secureToken = token;
      }
    }

    if (workOrderId) {
      formattedPayload.entityId = formattedPayload.entityId || workOrderId;
      formattedPayload.workOrderId = formattedPayload.workOrderId || workOrderId;
      formattedPayload.reference = formattedPayload.reference || workOrderId;
    }
  }

  if (eventType === 'BOOKING_CONFIRMED') {
    const frontendBase = getFrontendBaseUrl();
    const workOrderId = formattedPayload.workOrderId || formattedPayload.entityId || formattedPayload.relatedEntityId || null;
    let token = formattedPayload.secureToken || formattedPayload.data?.token || formattedPayload.data?.secure_token || null;

    if (!token && workOrderId) {
      try {
        const { pool } = require('../config/db');
        const [bRows] = await pool.query(
          'SELECT secure_token FROM booking_requests WHERE work_order_id = ? ORDER BY created_at DESC LIMIT 1',
          [workOrderId]
        );
        if (bRows.length > 0) token = bRows[0].secure_token;
      } catch (e) {}
    }

    const bookingUrl = token ? `${frontendBase}/booking/${token}` : `${frontendBase}/maintenance/my-tasks`;
    formattedPayload.actionUrl = bookingUrl;
    formattedPayload.bookingUrl = bookingUrl;
    formattedPayload.bookingLink = bookingUrl;

    const dataObj = formattedPayload.data || {};
    const resName = formattedPayload.residentName || formattedPayload.name || dataObj.resident_name || dataObj.residentName || null;
    const propAddr = formattedPayload.propertyAddress || formattedPayload.property || dataObj.property_address || dataObj.property || dataObj.address || null;
    const dateVal = formattedPayload.scheduledDate || formattedPayload.date || dataObj.scheduled_date || dataObj.date || null;
    const timeVal = formattedPayload.scheduledTimeSlot || formattedPayload.timeSlot || formattedPayload.time || dataObj.scheduled_time_slot || dataObj.time_slot || dataObj.timeSlot || null;
    const techName = formattedPayload.technicianName || dataObj.technician_name || null;

    formattedPayload.reference = workOrderId;
    formattedPayload.workOrderId = workOrderId;
    formattedPayload.entityId = workOrderId;
    formattedPayload.name = resName;
    formattedPayload.residentName = resName;
    formattedPayload.property = propAddr;
    formattedPayload.propertyAddress = propAddr;
    formattedPayload.date = dateVal;
    formattedPayload.scheduledDate = dateVal;
    formattedPayload.time = timeVal;
    formattedPayload.timeSlot = timeVal;
    formattedPayload.scheduledTimeSlot = timeVal;
    formattedPayload.technicianName = techName;

    if (formattedPayload.data && typeof formattedPayload.data === 'object') {
      formattedPayload.data.actionUrl = bookingUrl;
      formattedPayload.data.bookingUrl = bookingUrl;
      formattedPayload.data.bookingLink = bookingUrl;
      formattedPayload.data.reference = workOrderId;
      formattedPayload.data.name = resName;
      formattedPayload.data.residentName = resName;
      formattedPayload.data.property = propAddr;
      formattedPayload.data.propertyAddress = propAddr;
      formattedPayload.data.date = dateVal;
      formattedPayload.data.scheduledDate = dateVal;
      formattedPayload.data.time = timeVal;
      formattedPayload.data.timeSlot = timeVal;
      formattedPayload.data.scheduledTimeSlot = timeVal;
    }
  }

  if (eventType === 'BOOKING_REQUEST') {
    const frontendBase = getFrontendBaseUrl();
    const workOrderId = formattedPayload.workOrderId || formattedPayload.entityId || formattedPayload.relatedEntityId || null;
    let token = formattedPayload.bookingToken || formattedPayload.secureToken || formattedPayload.data?.bookingToken || formattedPayload.data?.secure_token || null;

    if (!token && workOrderId) {
      try {
        const { pool } = require('../config/db');
        const [bRows] = await pool.query(
          'SELECT secure_token FROM booking_requests WHERE work_order_id = ? ORDER BY created_at DESC LIMIT 1',
          [workOrderId]
        );
        if (bRows.length > 0) token = bRows[0].secure_token;
      } catch (e) {}
    }

    if (token) {
      const bookingUrl = `${frontendBase}/booking/${token}`;
      formattedPayload.actionUrl = bookingUrl;
      formattedPayload.bookingUrl = bookingUrl;
      formattedPayload.bookingLink = bookingUrl;
      if (formattedPayload.data && typeof formattedPayload.data === 'object') {
        formattedPayload.data.actionUrl = bookingUrl;
        formattedPayload.data.bookingUrl = bookingUrl;
        formattedPayload.data.bookingLink = bookingUrl;
      }
    }

    const dataObj = formattedPayload.data || {};
    const resName = formattedPayload.residentName || formattedPayload.name || dataObj.resident_name || dataObj.residentName || null;
    const propAddr = formattedPayload.propertyAddress || formattedPayload.property || dataObj.property_address || dataObj.property || dataObj.address || null;

    formattedPayload.reference = workOrderId;
    formattedPayload.workOrderId = workOrderId;
    formattedPayload.name = resName;
    formattedPayload.residentName = resName;
    formattedPayload.property = propAddr;
    formattedPayload.propertyAddress = propAddr;
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
