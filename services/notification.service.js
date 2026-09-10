const { pool } = require('../config/db');
const { sendEmail } = require('./notification/providers/email.provider');
const { sendSms } = require('./notification/providers/sms.provider');
const { dispatchN8NWebhook } = require('./webhook.service');

let ioInstance = null;

const SENSITIVE_FINANCIAL_FIELDS = [
  'quoteAmount', 'quote_amount', 'material_cost', 'material_costs', 
  'total_job_cost', 'revenue', 'profit', 'margin', 'cost'
];

const sanitizePayload = (role, dataPayload) => {
  if (!dataPayload) return null;
  if (role === 'OFFICE_ADMIN') return dataPayload; 
  const sanitized = { ...dataPayload };
  for (const field of SENSITIVE_FINANCIAL_FIELDS) {
    delete sanitized[field];
  }
  return sanitized;
};

const formatMessage = (messageTemplate, structuredData) => {
  if (!structuredData) return messageTemplate;
  // Replace all {{key}} in the template
  return messageTemplate.replace(/\{\{([^}]+)\}\}/g, (match, key) => {
    if (structuredData[key] !== undefined) {
      return structuredData[key];
    }
    // If it's a sensitive field that was stripped, hide it
    if (SENSITIVE_FINANCIAL_FIELDS.includes(key)) {
      return '<RESTRICTED>';
    }
    return ''; // Or keep it, but usually we want it blank if missing
  });
};

const notificationService = {
  setIoInstance(io) {
    ioInstance = io;
  },

  getIoInstance() {
    return ioInstance;
  },

  /**
   * Backwards compatible method used by existing Phase 1-9 code.
   * Promoted to use the full dispatcher under the hood.
   */
  async createNotification(data, connection = null) {
    // Map old style to new style
    const phone = data.contactPhone || data.technicianPhone || null;
    const email = data.contactEmail || null;
    return this.dispatch({
      recipientUserId: data.recipientUserId,
      recipientRole: data.recipientRole || 'OFFICE_ADMIN', // Default role if unspecified
      type: data.type,
      title: data.title,
      messageTemplate: data.message,
      structuredData: data.data || null,
      relatedEntityType: data.relatedEntityType,
      relatedEntityId: data.relatedEntityId,
      actionUrl: data.actionUrl,
      channels: data.channels || (phone || email ? ['IN_APP', 'SMS', 'EMAIL'] : ['IN_APP']),
      contactEmail: email,
      contactPhone: phone,
      technicianName: data.technicianName || null,
      technicianPhone: data.technicianPhone || null,
      propertyAddress: data.propertyAddress || null,
      skipWebhook: data.skipWebhook || false,
      connection
    });
  },

  async dispatch({
    recipientUserId,
    recipientRole,
    type,
    title,
    messageTemplate,
    structuredData,
    actionUrl,
    relatedEntityType,
    relatedEntityId,
    channels = ['IN_APP'],
    contactEmail = null,
    contactPhone = null,
    technicianName = null,
    technicianPhone = null,
    propertyAddress = null,
    skipWebhook = false,
    connection = null
  }) {
    const db = connection || pool;
    const sanitizedData = sanitizePayload(recipientRole, structuredData);
    const finalMessage = formatMessage(messageTemplate, sanitizedData);
    let notificationId = null;

    try {
      if (channels.includes('IN_APP') && recipientUserId && recipientRole !== 'TENANT') {
        const [userExists] = await db.query('SELECT id FROM users WHERE id = ?', [recipientUserId]);
        if (userExists.length > 0) {
          const [res] = await db.query(
            `INSERT INTO notifications 
              (user_id, notification_type, title, message, related_entity_type, related_entity_id, action_url)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [recipientUserId, type, title, finalMessage, relatedEntityType, relatedEntityId, actionUrl]
          );
          notificationId = res.insertId;

          if (ioInstance) {
             ioInstance.to(`user_${recipientUserId}`).emit('NEW_NOTIFICATION', {
               id: notificationId,
               type,
               title,
               message: finalMessage,
               actionUrl,
               createdAt: new Date().toISOString()
             });
          }
        }
      }

      if (channels.includes('EMAIL') && contactEmail) {
        await this._processChannelDelivery(db, notificationId, 'EMAIL', contactEmail, async () => {
           return await sendEmail({ to: contactEmail, subject: title, body: finalMessage });
        });
      }

      if (channels.includes('SMS') && contactPhone) {
         await this._processChannelDelivery(db, notificationId, 'SMS', contactPhone, async () => {
           return await sendSms({ to: contactPhone, message: finalMessage });
         });
      }

      // Dispatch event to N8N webhook asynchronously without blocking main flow
      if (!skipWebhook) {
        let n8nPayload = {
          notificationId,
          type,
          title,
          message: finalMessage,
          recipientUserId,
          contactEmail,
          contactPhone,
          actionUrl,
          entityType: relatedEntityType,
          entityId: relatedEntityId,
          technicianName,
          technicianPhone,
          propertyAddress,
          data: sanitizedData || structuredData || null,
        };

        if (type === 'TASK_ASSIGNED' || type === 'TASK_REASSIGNED') {
          const frontendBase = (process.env.FRONTEND_URL || process.env.VITE_PUBLIC_APP_URL || process.env.PUBLIC_APP_URL || 'https://nexus-fms.netlify.app').replace(/\/$/, '');
          const workOrderId = relatedEntityId || n8nPayload.entityId;
          n8nPayload.workOrderId = workOrderId;
          n8nPayload.entityId = workOrderId;
          n8nPayload.actionUrl = (type === 'TASK_ASSIGNED')
            ? (workOrderId ? `${frontendBase}/jobs/${workOrderId}` : (actionUrl || `${frontendBase}/maintenance/my-tasks`))
            : (actionUrl || `${frontendBase}/maintenance/my-tasks`);

          // Fetch technician details if missing
          if (recipientUserId && (!n8nPayload.technicianName || !n8nPayload.technicianPhone)) {
            try {
              const [techRows] = await db.query(
                `SELECT u.full_name, u.phone, u.email 
                 FROM users u 
                 WHERE u.id = ?`,
                [recipientUserId]
              );
              if (techRows.length > 0) {
                n8nPayload.technicianName = n8nPayload.technicianName || techRows[0].full_name;
                n8nPayload.technicianPhone = n8nPayload.technicianPhone || techRows[0].phone;
                n8nPayload.contactPhone = n8nPayload.contactPhone || n8nPayload.technicianPhone;
              }
            } catch (tErr) {
              console.warn('[NotificationService] Could not enrich technician info:', tErr.message);
            }
          }

          // Fetch propertyAddress if missing
          if (workOrderId && !n8nPayload.propertyAddress) {
            try {
              const [woRows] = await db.query(
                'SELECT property_address, title FROM work_orders WHERE id = ?',
                [workOrderId]
              );
              if (woRows.length > 0) {
                n8nPayload.propertyAddress = woRows[0].property_address;
              }
            } catch (wErr) {
              console.warn('[NotificationService] Could not enrich property address:', wErr.message);
            }
          }
        } else if (type === 'QUOTE_PHOTO_REQUEST' || type === 'NEW_QUOTE_REQUEST') {
          const frontendBase = (process.env.FRONTEND_URL || process.env.VITE_PUBLIC_APP_URL || process.env.PUBLIC_APP_URL || 'https://nexus-fms.netlify.app').replace(/\/$/, '');
          const workOrderId = relatedEntityId || n8nPayload.entityId;
          n8nPayload.workOrderId = workOrderId;
          n8nPayload.entityId = workOrderId;
          n8nPayload.reference = workOrderId;

          // Resolve secure_token from quote_requests
          let token = n8nPayload.data?.secure_token || n8nPayload.data?.token || n8nPayload.secureToken || null;
          if (!token && workOrderId) {
            try {
              const [qrRows] = await db.query(
                'SELECT secure_token FROM quote_requests WHERE work_order_id = ? ORDER BY created_at DESC LIMIT 1',
                [workOrderId]
              );
              if (qrRows.length > 0) token = qrRows[0].secure_token;
            } catch (e) {}
          }

          if (token) {
            const uploadUrl = `${frontendBase}/quote-request/${token}`;
            n8nPayload.actionUrl = uploadUrl;
            n8nPayload.uploadUrl = uploadUrl;
            n8nPayload.photoUploadLink = uploadUrl;
            if (n8nPayload.data) {
              n8nPayload.data.actionUrl = uploadUrl;
              n8nPayload.data.uploadUrl = uploadUrl;
              n8nPayload.data.photoUploadLink = uploadUrl;
              n8nPayload.data.uploadLink = uploadUrl;
            }
          }
        } else if (type === 'BOOKING_REQUEST') {
          const frontendBase = (process.env.FRONTEND_URL || process.env.VITE_PUBLIC_APP_URL || process.env.PUBLIC_APP_URL || 'https://nexus-fms.netlify.app').replace(/\/$/, '');
          const workOrderId = relatedEntityId || n8nPayload.entityId;
          n8nPayload.workOrderId = workOrderId;
          n8nPayload.entityId = workOrderId;

          // Resolve secure_token from booking_requests if missing
          let token = n8nPayload.data?.bookingToken || n8nPayload.data?.secure_token || n8nPayload.secureToken || null;
          if (!token && workOrderId) {
            try {
              const [bRows] = await db.query(
                'SELECT secure_token FROM booking_requests WHERE work_order_id = ? ORDER BY created_at DESC LIMIT 1',
                [workOrderId]
              );
              if (bRows.length > 0) token = bRows[0].secure_token;
            } catch (e) {}
          }

          if (token) {
            const bookingUrl = `${frontendBase}/booking/${token}`;
            n8nPayload.actionUrl = bookingUrl;
            n8nPayload.bookingUrl = bookingUrl;
            n8nPayload.bookingLink = bookingUrl;
            if (n8nPayload.data) {
              n8nPayload.data.actionUrl = bookingUrl;
              n8nPayload.data.bookingUrl = bookingUrl;
              n8nPayload.data.bookingLink = bookingUrl;
            }
          }
        } else if (type === 'BOOKING_CONFIRMED') {
          const frontendBase = (process.env.FRONTEND_URL || process.env.VITE_PUBLIC_APP_URL || process.env.PUBLIC_APP_URL || 'https://nexus-fms.netlify.app').replace(/\/$/, '');
          const workOrderId = relatedEntityId || n8nPayload.entityId;
          n8nPayload.workOrderId = workOrderId;
          n8nPayload.entityId = workOrderId;
          n8nPayload.reference = workOrderId;

          // Resolve secure token if missing
          let token = n8nPayload.data?.token || n8nPayload.data?.secure_token || n8nPayload.secureToken || null;
          if (!token && workOrderId) {
            try {
              const [bRows] = await db.query(
                'SELECT secure_token FROM booking_requests WHERE work_order_id = ? ORDER BY created_at DESC LIMIT 1',
                [workOrderId]
              );
              if (bRows.length > 0) token = bRows[0].secure_token;
            } catch (e) {}
          }

          const bookingUrl = token ? `${frontendBase}/booking/${token}` : `${frontendBase}/maintenance/my-tasks`;
          n8nPayload.actionUrl = bookingUrl;
          n8nPayload.bookingUrl = bookingUrl;
          n8nPayload.bookingLink = bookingUrl;

          // Ensure resident name, property address, date and time slot are present at top level
          const dataObj = n8nPayload.data || {};
          const resName = n8nPayload.residentName || n8nPayload.name || dataObj.resident_name || dataObj.residentName || null;
          const propAddr = n8nPayload.propertyAddress || n8nPayload.property || dataObj.address || dataObj.property_address || dataObj.property || null;
          const dateVal = n8nPayload.scheduledDate || n8nPayload.date || dataObj.scheduled_date || dataObj.date || null;
          const timeVal = n8nPayload.scheduledTimeSlot || n8nPayload.timeSlot || n8nPayload.time || dataObj.scheduled_time_slot || dataObj.time_slot || dataObj.timeSlot || null;

          n8nPayload.name = resName;
          n8nPayload.residentName = resName;
          n8nPayload.property = propAddr;
          n8nPayload.propertyAddress = propAddr;
          n8nPayload.date = dateVal;
          n8nPayload.scheduledDate = dateVal;
          n8nPayload.time = timeVal;
          n8nPayload.timeSlot = timeVal;
          n8nPayload.scheduledTimeSlot = timeVal;

          if (n8nPayload.data && typeof n8nPayload.data === 'object') {
            n8nPayload.data.actionUrl = bookingUrl;
            n8nPayload.data.bookingUrl = bookingUrl;
            n8nPayload.data.bookingLink = bookingUrl;
            n8nPayload.data.reference = workOrderId;
            n8nPayload.data.name = resName;
            n8nPayload.data.residentName = resName;
            n8nPayload.data.property = propAddr;
            n8nPayload.data.propertyAddress = propAddr;
            n8nPayload.data.date = dateVal;
            n8nPayload.data.scheduledDate = dateVal;
            n8nPayload.data.time = timeVal;
            n8nPayload.data.timeSlot = timeVal;
            n8nPayload.data.scheduledTimeSlot = timeVal;
          }
        }

        dispatchN8NWebhook(type, n8nPayload).catch(err => console.warn('[N8N_DISPATCH_WARN] Async webhook skipped:', err.message));
      }

    } catch (error) {
      console.error('[NotificationService] Dispatch failed:', error);
      if (connection) throw error; 
    }
  },

  async _processChannelDelivery(db, notificationId, channel, recipient, deliveryFn) {
     const [trackRes] = await db.query(
       `INSERT INTO notification_delivery (notification_id, channel, recipient, status, attempts) VALUES (?, ?, ?, 'PENDING', 0)`,
       [notificationId || null, channel, recipient]
     );
     const deliveryId = trackRes.insertId;

     let attempt = 1;
     const maxAttempts = 3;
     let success = false;
     let providerRes = null;
     let lastError = null;

     while (attempt <= maxAttempts && !success) {
       try {
         await db.query('UPDATE notification_delivery SET attempts = ?, last_attempt_at = NOW() WHERE id = ?', [attempt, deliveryId]);
         providerRes = await deliveryFn();
         success = true;
         await db.query(
           `UPDATE notification_delivery SET status = 'SENT', sent_at = NOW(), provider = ?, provider_message_id = ? WHERE id = ?`,
           [providerRes.provider, providerRes.messageId, deliveryId]
         );
       } catch (error) {
         lastError = error;
         attempt++;
         if (attempt <= maxAttempts) await new Promise(r => setTimeout(r, 1000 * attempt));
       }
     }

     if (!success) {
       await db.query(
         `UPDATE notification_delivery SET status = 'FAILED', failed_at = NOW(), error_message = ? WHERE id = ?`,
         [lastError.message.substring(0, 500), deliveryId]
       );
       console.error(`[NotificationService] Channel ${channel} failed after ${maxAttempts} attempts for delivery ID ${deliveryId}`);
     }
  }
};

module.exports = notificationService;
