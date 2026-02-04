// ============================================================
// GOOGLE APPS SCRIPT - Lab SWPS Booking Handler
// Paste this entire file into script.google.com
// ============================================================

// ============ CONFIGURATION ============
const SPREADSHEET_ID = '18rFsiX9gbn23kbOtkPOrLrhuwcaatV4sR72RaZtpQ2I';
const CALENDAR_ID = 'eyelab@swps.edu.pl';
const NOTIFY_EMAILS = ['eyelab@swps.edu.pl'];
const SHEET_NAME = 'Sheet1'; // Change if your tab has a different name
// =======================================

function doPost(e) {
  try {
    const data = JSON.parse(e.postData.contents);
    const result = processBooking(data);
    return ContentService
      .createTextOutput(JSON.stringify(result))
      .setMimeType(ContentService.MimeType.JSON);
  } catch (error) {
    console.error('doPost error:', error);
    return ContentService
      .createTextOutput(JSON.stringify({ success: false, error: error.toString() }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}

function doGet(e) {
  // Returns all bookings (useful for checking available slots)
  try {
    const action = e && e.parameter && e.parameter.action;
    
    if (action === 'slots') {
      const dateStr = e.parameter.date;
      const bookedSlots = getBookedSlots(dateStr);
      return ContentService
        .createTextOutput(JSON.stringify({ success: true, date: dateStr, bookedSlots }))
        .setMimeType(ContentService.MimeType.JSON);
    }
    
    const bookings = getAllBookings();
    return ContentService
      .createTextOutput(JSON.stringify({ success: true, bookings }))
      .setMimeType(ContentService.MimeType.JSON);
  } catch (error) {
    return ContentService
      .createTextOutput(JSON.stringify({ success: false, error: error.toString() }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}

function processBooking(data) {
  const sheet = SpreadsheetApp.openById(SPREADSHEET_ID).getSheetByName(SHEET_NAME);
  
  if (!sheet) {
    throw new Error('Sheet not found: ' + SHEET_NAME);
  }
  
  const email = (data.email || '').trim().toLowerCase();
  
  if (!email) {
    return { success: false, error: 'Email is required' };
  }
  
  // Find existing booking by email
  const existingRow = findRowByEmail(sheet, email);
  const isUpdate = existingRow !== null;
  let oldEventId = null;
  let oldDate = null;
  let oldTimeSlot = null;
  
  // If updating, get the old calendar event ID to delete it
  if (isUpdate) {
    const oldData = sheet.getRange(existingRow, 1, 1, 10).getValues()[0];
    oldDate = oldData[1];      // Column B = date
    oldTimeSlot = oldData[2];  // Column C = time
    oldEventId = oldData[9];   // Column J = calendar event ID
  }
  
  // Prepare row data (columns A-J)
  const educationLabels = {
    'higher': 'wyższe',
    'studies': 'studiuję',
    'other': 'inne'
  };
  
  const rowData = [
    data.id || Date.now().toString(),           // A: ID
    data.date,                                   // B: Data
    data.timeSlot,                               // C: Godzina
    data.name,                                   // D: Imię i nazwisko
    email,                                       // E: Email
    data.gender,                                 // F: Płeć
    data.age,                                    // G: Wiek
    educationLabels[data.education] || data.education, // H: Wykształcenie
    data.timestamp || new Date().toISOString(), // I: Timestamp
    ''                                          // J: CalendarEventId (updated later)
  ];
  
  // Write to sheet (update existing row or append new)
  if (isUpdate) {
    sheet.getRange(existingRow, 1, 1, rowData.length).setValues([rowData]);
  } else {
    sheet.appendRow(rowData);
  }
  
  // Get the row number for the new/updated entry
  const targetRow = isUpdate ? existingRow : sheet.getLastRow();
  
  // Create/update calendar event
  let calendarEventId = null;
  try {
    // Delete old calendar event if updating
    if (oldEventId) {
      try {
        const calendar = CalendarApp.getCalendarById(CALENDAR_ID);
        if (calendar) {
          const oldEvent = calendar.getEventById(oldEventId);
          if (oldEvent) {
            oldEvent.deleteEvent();
          }
        }
      } catch (calError) {
        console.error('Error deleting old event:', calError);
        // Event may already be deleted, continue
      }
    }
    
    // Create new calendar event
    calendarEventId = createCalendarEvent(data);
    
    // Save calendar event ID to sheet (column J)
    if (calendarEventId) {
      sheet.getRange(targetRow, 10).setValue(calendarEventId);
    }
  } catch (calError) {
    console.error('Calendar error:', calError);
  }
  
  // Send email notification
  try {
    sendNotificationEmail(data, isUpdate, oldDate, oldTimeSlot);
  } catch (emailError) {
    console.error('Email error:', emailError);
  }
  
  return {
    success: true,
    isUpdate,
    bookingId: rowData[0],
    calendarEventId
  };
}

function findRowByEmail(sheet, email) {
  const data = sheet.getDataRange().getValues();
  const normalizedEmail = email.trim().toLowerCase();
  
  // Start from row 2 (skip header)
  for (let i = 1; i < data.length; i++) {
    const rowEmail = (data[i][4] || '').toString().trim().toLowerCase(); // Column E = email
    if (rowEmail === normalizedEmail) {
      return i + 1; // Sheet rows are 1-indexed
    }
  }
  return null;
}

function getAllBookings() {
  const sheet = SpreadsheetApp.openById(SPREADSHEET_ID).getSheetByName(SHEET_NAME);
  const data = sheet.getDataRange().getValues();
  
  if (data.length <= 1) {
    return [];
  }
  
  const bookings = [];
  
  for (let i = 1; i < data.length; i++) {
    const row = data[i];
    if (row[0]) { // Has ID
      // Handle date - could be Date object or string
      let dateStr = row[1];
      if (dateStr instanceof Date) {
        dateStr = Utilities.formatDate(dateStr, Session.getScriptTimeZone(), 'yyyy-MM-dd');
      }
      
      // Handle timeSlot - could be Date object or string
      let timeSlot = row[2];
      if (timeSlot instanceof Date) {
        timeSlot = Utilities.formatDate(timeSlot, Session.getScriptTimeZone(), 'HH:mm');
      } else if (typeof timeSlot === 'string') {
        // Normalize "9:00" to "09:00"
        const match = timeSlot.match(/^(\d{1,2}):(\d{2})$/);
        if (match) {
          timeSlot = match[1].padStart(2, '0') + ':' + match[2];
        }
      }
      
      bookings.push({
        id: row[0],
        date: dateStr,
        timeSlot: timeSlot,
        name: row[3],
        email: row[4],
        gender: row[5],
        age: row[6],
        education: row[7],
        timestamp: row[8]
      });
    }
  }
  
  return bookings;
}

function getBookedSlots(dateStr) {
  const bookings = getAllBookings();
  return bookings
    .filter(b => b.date === dateStr)
    .map(b => b.timeSlot);
}

function createCalendarEvent(data) {
  const calendar = CalendarApp.getCalendarById(CALENDAR_ID);
  
  if (!calendar) {
    console.error('Calendar not found: ' + CALENDAR_ID);
    return null;
  }
  
  // Parse date and time
  const [year, month, day] = data.date.split('-').map(Number);
  const [hour, minute] = data.timeSlot.split(':').map(Number);
  
  const startTime = new Date(year, month - 1, day, hour, minute);
  const endTime = new Date(startTime.getTime() + 60 * 60 * 1000); // +1 hour
  
  const title = 'Badanie Lab SWPS - ' + data.name;
  
  const educationLabels = {
    'higher': 'wyższe',
    'studies': 'studiuję',
    'other': 'inne'
  };
  
  const genderLabels = {
    'male': 'Mężczyzna',
    'female': 'Kobieta',
    'non-binary': 'Osoba niebinarna',
    'prefer-not-to-say': 'Nie podano'
  };
  
  const description = [
    'Imię i nazwisko: ' + data.name,
    'Email: ' + data.email,
    'Płeć: ' + (genderLabels[data.gender] || data.gender),
    'Wiek: ' + data.age,
    'Wykształcenie: ' + (educationLabels[data.education] || data.education),
    '',
    'ID: ' + data.id
  ].join('\n');
  
  const event = calendar.createEvent(title, startTime, endTime, {
    description: description,
    location: 'Lab SWPS'
  });
  
  return event.getId();
}

function sendNotificationEmail(data, isUpdate, oldDate, oldTimeSlot) {
  if (!NOTIFY_EMAILS || NOTIFY_EMAILS.length === 0) {
    return;
  }
  
  const educationLabels = {
    'higher': 'wyższe',
    'studies': 'studiuję',
    'other': 'inne'
  };
  
  const genderLabels = {
    'male': 'Mężczyzna',
    'female': 'Kobieta',
    'non-binary': 'Osoba niebinarna',
    'prefer-not-to-say': 'Nie podano'
  };
  
  const dateObj = new Date(data.date + 'T00:00:00');
  const dateDisplay = dateObj.toLocaleDateString('pl-PL', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric'
  });
  
  let subject, statusLine;
  
  if (isUpdate) {
    subject = 'Aktualizacja rezerwacji: ' + dateDisplay + ' ' + data.timeSlot;
    if (oldDate && oldTimeSlot && (oldDate !== data.date || oldTimeSlot !== data.timeSlot)) {
      const oldDateObj = new Date(oldDate + 'T00:00:00');
      const oldDateDisplay = oldDateObj.toLocaleDateString('pl-PL', {
        weekday: 'long',
        year: 'numeric',
        month: 'long',
        day: 'numeric'
      });
      statusLine = 'Rezerwacja została zmieniona z ' + oldDateDisplay + ' ' + oldTimeSlot + ' na nowy termin.';
    } else {
      statusLine = 'Dane rezerwacji zostały zaktualizowane.';
    }
  } else {
    subject = 'Nowa rezerwacja: ' + dateDisplay + ' ' + data.timeSlot;
    statusLine = 'Nowa rezerwacja została dodana.';
  }
  
  const body = [
    statusLine,
    '',
    'Data: ' + dateDisplay,
    'Godzina: ' + data.timeSlot,
    'Imię i nazwisko: ' + data.name,
    'Email: ' + data.email,
    'Płeć: ' + (genderLabels[data.gender] || data.gender),
    'Wiek: ' + data.age,
    'Wykształcenie: ' + (educationLabels[data.education] || data.education),
    '',
    'ID rezerwacji: ' + data.id
  ].join('\n');
  
  const htmlBody = [
    '<div style="font-family: Arial, sans-serif; line-height: 1.6;">',
    '<h2>' + (isUpdate ? 'Aktualizacja rezerwacji' : 'Nowa rezerwacja') + '</h2>',
    '<p>' + statusLine + '</p>',
    '<table cellpadding="8" style="border-collapse: collapse;">',
    '<tr><td><strong>Data:</strong></td><td>' + dateDisplay + '</td></tr>',
    '<tr><td><strong>Godzina:</strong></td><td>' + data.timeSlot + '</td></tr>',
    '<tr><td><strong>Imię i nazwisko:</strong></td><td>' + data.name + '</td></tr>',
    '<tr><td><strong>Email:</strong></td><td>' + data.email + '</td></tr>',
    '<tr><td><strong>Płeć:</strong></td><td>' + (genderLabels[data.gender] || data.gender) + '</td></tr>',
    '<tr><td><strong>Wiek:</strong></td><td>' + data.age + '</td></tr>',
    '<tr><td><strong>Wykształcenie:</strong></td><td>' + (educationLabels[data.education] || data.education) + '</td></tr>',
    '</table>',
    '<p style="color: #666; margin-top: 16px;">ID: ' + data.id + '</p>',
    '</div>'
  ].join('\n');
  
  // Send to lab notification emails
  NOTIFY_EMAILS.forEach(function(emailAddr) {
    try {
      MailApp.sendEmail({
        to: emailAddr,
        subject: subject,
        body: body,
        htmlBody: htmlBody,
        name: 'Lab SWPS'
      });
      console.log('Notification sent to: ' + emailAddr);
    } catch (err) {
      console.error('Failed to send to ' + emailAddr + ':', err);
    }
  });
  
  // Send confirmation to the person who booked
  sendBookerConfirmation(data, isUpdate, dateDisplay);
}

// ============ TEST FUNCTION ============
// Run this to test the script works
function testProcessBooking() {
  const testData = {
    id: 'test-' + Date.now(),
    date: '2025-11-25',
    timeSlot: '10:00',
    name: 'Test User',
    email: 'test@example.com',
    gender: 'male',
    age: 25,
    education: 'higher',
    timestamp: new Date().toISOString()
  };
  
  const result = processBooking(testData);
  console.log('Test result:', result);
}

// Send confirmation email to the person who made the booking
function sendBookerConfirmation(data, isUpdate, dateDisplay) {
  if (!data.email) {
    return;
  }
  
  const subject = isUpdate 
    ? 'Potwierdzenie zmiany rezerwacji - Lab SWPS'
    : 'Potwierdzenie rezerwacji - Lab SWPS';
  
  const greeting = data.name ? ('Cześć ' + data.name.split(' ')[0] + '!') : 'Cześć!';
  
  const body = [
    greeting,
    '',
    isUpdate 
      ? 'Twoja rezerwacja została zaktualizowana.'
      : 'Dziękujemy za zapisanie się na badanie w Lab SWPS!',
    '',
    'Szczegóły wizyty:',
    '📅 Data: ' + dateDisplay,
    '🕐 Godzina: ' + data.timeSlot,
    '📍 Miejsce: Lab SWPS',
    '',
    'Jeśli potrzebujesz zmienić termin, wejdź ponownie na stronę rejestracji i zapisz się używając tego samego adresu e-mail.',
    '',
    'Do zobaczenia!',
    'Zespół Lab SWPS',
    '',
    '---',
    'ID rezerwacji: ' + data.id
  ].join('\n');
  
  const htmlBody = [
    '<div style="font-family: Arial, sans-serif; line-height: 1.6; max-width: 600px; margin: 0 auto;">',
    '<div style="background-color: #007aff; color: white; padding: 20px; text-align: center; border-radius: 10px 10px 0 0;">',
    '<h1 style="margin: 0;">📅 Lab SWPS</h1>',
    '</div>',
    '<div style="background-color: #f9f9f9; padding: 30px; border-radius: 0 0 10px 10px;">',
    '<h2 style="color: #333;">' + greeting + '</h2>',
    '<p style="color: #555;">' + (isUpdate ? 'Twoja rezerwacja została zaktualizowana.' : 'Dziękujemy za zapisanie się na badanie w Lab SWPS!') + '</p>',
    '<div style="background-color: white; border-radius: 10px; padding: 20px; margin: 20px 0; border-left: 4px solid #007aff;">',
    '<h3 style="margin-top: 0; color: #007aff;">Szczegóły wizyty</h3>',
    '<p style="margin: 10px 0;"><strong>📅 Data:</strong> ' + dateDisplay + '</p>',
    '<p style="margin: 10px 0;"><strong>🕐 Godzina:</strong> ' + data.timeSlot + '</p>',
    '<p style="margin: 10px 0;"><strong>📍 Miejsce:</strong> Lab SWPS</p>',
    '</div>',
    '<p style="color: #666; font-size: 14px;">Jeśli potrzebujesz zmienić termin, wejdź ponownie na stronę rejestracji i zapisz się używając tego samego adresu e-mail.</p>',
    '<p style="color: #333; margin-top: 30px;">Do zobaczenia!<br><strong>Zespół Lab SWPS</strong></p>',
    '<hr style="border: none; border-top: 1px solid #ddd; margin: 20px 0;">',
    '<p style="color: #999; font-size: 12px;">ID rezerwacji: ' + data.id + '</p>',
    '</div>',
    '</div>'
  ].join('\n');
  
  try {
    MailApp.sendEmail({
      to: data.email,
      subject: subject,
      body: body,
      htmlBody: htmlBody,
      replyTo: 'eyelab@swps.edu.pl',
      name: 'Lab SWPS'
    });
    console.log('Confirmation email sent to: ' + data.email);
  } catch (error) {
    console.error('Failed to send confirmation to booker:', error);
  }
}
