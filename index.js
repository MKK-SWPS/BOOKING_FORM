const express = require('express')
const fs = require('fs').promises
const path = require('path')
const { Resend } = require('resend')
const { createEvents } = require('ics')

const app = express()
const port = 3000

app.use(express.json())
app.use(express.static('public'))

// Try to use Vercel KV if environment variables are set
let kv = null
const useVercelKV = process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN
if (useVercelKV) {
  try {
    kv = require('@vercel/kv').kv
    console.log('Using Vercel KV for storage')
  } catch (error) {
    console.log('Vercel KV not available, using file system')
  }
} else {
  console.log('Using file system for local development (set KV_REST_API_URL and KV_REST_API_TOKEN to use Vercel KV)')
}

let resendClient = null
const notificationSender = (process.env.NOTIFY_EMAIL_FROM || '').trim()
const notificationRecipients = (process.env.NOTIFY_EMAIL_TO || '')
  .split(',')
  .map(item => item.trim())
  .filter(Boolean)

if (process.env.RESEND_API_KEY && notificationSender && notificationRecipients.length > 0) {
  try {
    resendClient = new Resend(process.env.RESEND_API_KEY)
    console.log('Powiadomienia e-mail dla rezerwacji są włączone')
  } catch (error) {
    console.error('Nie udało się zainicjować Resend:', error)
  }
} else {
  console.log('Powiadomienia e-mail są wyłączone (brak RESEND_API_KEY, NOTIFY_EMAIL_FROM lub NOTIFY_EMAIL_TO)')
}

const BOOKINGS_DIR = path.join(__dirname, 'bookings')
const BOOKINGS_FILE = path.join(BOOKINGS_DIR, 'all-bookings.json')

const ALL_TIME_SLOTS = [
  '08:00',
  '09:00',
  '10:00',
  '11:00',
  '12:00',
  '13:00',
  '14:00',
  '15:00',
  '16:00',
  '17:00',
  '18:00',
  '19:00'
]

const ALLOWED_EDUCATION_LEVELS = new Set(['higher', 'studies', 'other'])
const EDUCATION_LABELS = {
  higher: 'wyższe',
  studies: 'studiuję',
  other: 'inne'
}

const MIN_BOOKING_DATE = '2025-11-24'
const MAX_BOOKING_DATE = '2025-12-05'

function toDateOnlyString(date) {
  const normalized = new Date(date)
  normalized.setHours(0, 0, 0, 0)
  return normalized.toISOString().split('T')[0]
}

function getDateBounds() {
  return { minDate: MIN_BOOKING_DATE, maxDate: MAX_BOOKING_DATE }
}

function isValidBookingDate(dateStr) {
  if (!dateStr || typeof dateStr !== 'string') {
    return false
  }

  const parsed = new Date(`${dateStr}T00:00:00`)
  if (Number.isNaN(parsed.getTime())) {
    return false
  }

  const { minDate, maxDate } = getDateBounds()
  return dateStr >= minDate && dateStr <= maxDate
}

function normalizeEmail(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : ''
}

function isValidEmail(value) {
  const trimmed = normalizeEmail(value)
  if (!trimmed) {
    return false
  }

  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
  return emailRegex.test(trimmed)
}

async function sendBookingNotification(booking, replacedBooking) {
  if (!resendClient || !notificationSender || notificationRecipients.length === 0) {
    return
  }

  const dateDisplay = new Date(`${booking.date}T00:00:00`).toLocaleDateString('pl-PL', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric'
  })

  const subject = replacedBooking
    ? `Aktualizacja rezerwacji: ${dateDisplay} ${booking.timeSlot}`
    : `Nowa rezerwacja: ${dateDisplay} ${booking.timeSlot}`

  const statusLine = replacedBooking
    ? 'Uwaga: ta rezerwacja zastąpiła istniejący wpis dla tego adresu e-mail.'
    : 'Nowa rezerwacja została dodana do bazy.'

  const educationLabel = booking.education && EDUCATION_LABELS[booking.education]
    ? EDUCATION_LABELS[booking.education]
    : (booking.education || '—')

  const nativeLanguageRow = typeof booking.nativePolishSpeaker !== 'undefined'
    ? `<tr>
            <td style="font-weight: bold; padding-right: 16px;">Polski jako język ojczysty</td>
            <td>${booking.nativePolishSpeaker ? 'Tak' : 'Nie'}</td>
          </tr>`
    : ''

  const htmlBody = `
    <div style="font-family: Arial, sans-serif; line-height: 1.6; color: #111;">
      <h2 style="margin-bottom: 12px;">${replacedBooking ? 'Aktualizacja rezerwacji' : 'Nowa rezerwacja'}</h2>
      <p style="margin: 0 0 16px;">${statusLine}</p>
      <table cellpadding="6" cellspacing="0" style="border-collapse: collapse;">
        <tbody>
          <tr>
            <td style="font-weight: bold; padding-right: 16px;">Data</td>
            <td>${dateDisplay}</td>
          </tr>
          <tr>
            <td style="font-weight: bold; padding-right: 16px;">Godzina</td>
            <td>${booking.timeSlot}</td>
          </tr>
          <tr>
            <td style="font-weight: bold; padding-right: 16px;">Imię i nazwisko</td>
            <td>${booking.name}</td>
          </tr>
          <tr>
            <td style="font-weight: bold; padding-right: 16px;">Adres e-mail</td>
            <td>${booking.email}</td>
          </tr>
          <tr>
            <td style="font-weight: bold; padding-right: 16px;">Płeć</td>
            <td>${booking.gender}</td>
          </tr>
          <tr>
            <td style="font-weight: bold; padding-right: 16px;">Wiek</td>
            <td>${booking.age}</td>
          </tr>
          <tr>
            <td style="font-weight: bold; padding-right: 16px;">Wykształcenie</td>
            <td>${educationLabel}</td>
          </tr>
          ${nativeLanguageRow}
        </tbody>
      </table>
      <p style="margin-top: 16px; font-size: 13px; color: #555;">ID rezerwacji: ${booking.id}</p>
      <p style="margin-top: 12px; font-size: 13px; color: #555;">W załączniku znajduje się plik kalendarza (ICS) dla tej rezerwacji.</p>
    </div>
  `

  const textBody = `${statusLine}

Data: ${dateDisplay}
Godzina: ${booking.timeSlot}
Imię i nazwisko: ${booking.name}
Adres e-mail: ${booking.email}
Płeć: ${booking.gender}
Wiek: ${booking.age}
ID rezerwacji: ${booking.id}

Plik ICS z wpisem kalendarza znajduje się w załączniku.`

  let attachments = []

  try {
    if (booking.date && booking.timeSlot) {
      const [year, month, day] = booking.date.split('-').map(Number)
      const [hour, minute] = booking.timeSlot.split(':').map(Number)

      if (![year, month, day, hour, minute].some(Number.isNaN)) {
        const summaryName = booking.name ? ` - ${booking.name}` : ''
        const eventConfig = {
          start: [year, month, day, hour, minute],
          duration: { hours: 1 },
          startInputType: 'local',
          startOutputType: 'local',
          title: `Badanie Lab SWPS${summaryName}`,
          description: [
            statusLine,
            `Imię i nazwisko: ${booking.name || '-'}`,
            `Adres e-mail: ${booking.email || '-'}`,
            `Płeć: ${booking.gender || '-'}`,
            `Wiek: ${typeof booking.age !== 'undefined' ? booking.age : '-'}`
          ].join('\n'),
          location: 'Lab SWPS',
          productId: 'Lab SWPS Booking Calendar',
          status: 'CONFIRMED',
          calName: 'Rezerwacje Lab SWPS',
          uid: `lab-swps-${booking.id}`
        }

        const { error: icsError, value: icsValue } = createEvents([eventConfig])

        if (!icsError && icsValue) {
          const sanitizedTime = booking.timeSlot.replace(/[^0-9]/g, '')
          attachments.push({
            filename: `rezerwacja-${booking.date}-${sanitizedTime || 'czas'}.ics`,
            content: Buffer.from(icsValue, 'utf8').toString('base64')
          })
        } else if (icsError) {
          console.error('Błąd generowania załącznika ICS:', icsError)
        }
      }
    }
  } catch (icsGenerationError) {
    console.error('Błąd tworzenia załącznika ICS:', icsGenerationError)
  }

  try {
    await resendClient.emails.send({
      from: notificationSender,
      to: notificationRecipients,
      subject,
      html: htmlBody,
      text: textBody,
      attachments: attachments.length > 0 ? attachments : undefined
    })
  } catch (error) {
    console.error('Błąd wysyłania powiadomienia e-mail:', error)
  }
}

async function ensureBookingsFile() {
  try {
    await fs.access(BOOKINGS_FILE)
  } catch (error) {
    await fs.mkdir(BOOKINGS_DIR, { recursive: true })
    await fs.writeFile(BOOKINGS_FILE, '[]', 'utf8')
  }
}

async function loadBookings() {
  // Use Vercel KV if available, otherwise fall back to file system
  if (kv) {
    try {
      const allKeys = await kv.keys('booking:*')
      if (!allKeys || allKeys.length === 0) {
        return []
      }
      
      const bookings = []
      for (const key of allKeys) {
        const booking = await kv.get(key)
        if (booking) {
          bookings.push(booking)
        }
      }
      return bookings
    } catch (error) {
      console.error('Error loading from Vercel KV:', error)
      return []
    }
  }

  // File system fallback for local development
  await ensureBookingsFile()

  const data = await fs.readFile(BOOKINGS_FILE, 'utf8')
  if (!data.trim()) {
    return []
  }

  let bookings
  try {
    bookings = JSON.parse(data)
  } catch (error) {
    console.error('Failed to parse bookings file, resetting to empty array', error)
    bookings = []
  }

  let needsSave = false
  const normalized = bookings.map(booking => {
    if (booking.date) {
      return booking
    }

    if (booking.timestamp) {
      const derivedDate = toDateOnlyString(new Date(booking.timestamp))
      if (derivedDate) {
        needsSave = true
        return { ...booking, date: derivedDate }
      }
    }

    return booking
  })

  if (needsSave) {
    await saveBookings(normalized)
    return normalized
  }

  return bookings
}

async function saveBookings(bookings) {
  // Use Vercel KV if available
  if (kv) {
    try {
      // Save each booking with a unique key
      for (const booking of bookings) {
        await kv.set(`booking:${booking.id}`, booking)
      }
      return
    } catch (error) {
      console.error('Error saving to Vercel KV:', error)
      throw error
    }
  }

  // File system fallback for local development
  await fs.mkdir(BOOKINGS_DIR, { recursive: true })
  await fs.writeFile(BOOKINGS_FILE, `${JSON.stringify(bookings, null, 2)}\n`, 'utf8')
}

app.get('/', (req, res) => {
  res.send(`
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Rejestracja na Badanie w Lab SWPS</title>
    <style>
        * {
            box-sizing: border-box;
            margin: 0;
            padding: 0;
        }
        
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            background-color: #0f1419;
            min-height: 100vh;
            padding: 20px;
        }
        
        .booking-container {
            max-width: 600px;
            margin: 0 auto;
            background-color: #1a1a1a;
            border-radius: 15px;
            overflow: hidden;
            box-shadow: 0 4px 20px rgba(0,0,0,0.3);
        }
        
        .booking-header {
            background-color: #2d2d2d;
            color: white;
            padding: 20px;
            text-align: center;
            border-bottom: 1px solid #3d3d3d;
        }
        
        .booking-header h1 {
            font-size: 24px;
            font-weight: 600;
            margin-bottom: 5px;
        }
        
        .booking-header p {
            color: #999;
            font-size: 14px;
        }
        
        .booking-content {
            padding: 30px;
        }
        
        .form-section {
            margin-bottom: 25px;
        }
        
        .form-section h2 {
            color: #007aff;
            font-size: 18px;
            margin-bottom: 15px;
        }
        
        .form-group {
            margin-bottom: 15px;
        }
        
        .form-group label {
            display: block;
            color: #e5e5e5;
            margin-bottom: 8px;
            font-size: 14px;
            font-weight: 500;
        }
        
        .form-group input,
        .form-group select {
            width: 100%;
            padding: 12px;
          background-color: #4a4a4a;
            border: 1px solid #3d3d3d;
            border-radius: 8px;
            color: white;
            font-size: 14px;
            transition: border-color 0.2s;
        }
        
        .form-group input:focus,
        .form-group select:focus {
            outline: none;
            border-color: #007aff;
        }
        
        .form-group input::placeholder {
            color: #666;
        }
        
        .checkbox-group label {
          display: flex;
          align-items: center;
          gap: 10px;
          margin: 0;
        }

        .checkbox-group input[type="checkbox"] {
          width: auto;
          accent-color: #007aff;
        }
        
        .date-picker-container {
          display: flex;
          flex-direction: column;
          gap: 8px;
        }

        .date-picker-container input[type="date"] {
          padding: 12px;
          background-color: #4a4a4a;
          border: 1px solid #3d3d3d;
          border-radius: 8px;
          color: white;
          font-size: 14px;
          cursor: pointer;
        }

        .date-picker-container input[type="date"]::-webkit-calendar-picker-indicator {
          filter: invert(1);
        }

        .date-picker-container input[type="date"]:focus {
          outline: none;
          border-color: #007aff;
        }
        
        .date-help {
            color: #666;
            font-size: 12px;
        }
        
        .time-slots {
            display: grid;
            grid-template-columns: repeat(auto-fill, minmax(100px, 1fr));
            gap: 10px;
            margin-top: 15px;
        }
        
        .time-slot {
            padding: 12px;
            background-color: #2d2d2d;
            border: 2px solid #3d3d3d;
            border-radius: 8px;
            color: white;
            cursor: pointer;
            text-align: center;
            transition: all 0.2s;
            font-size: 14px;
            font-weight: 500;
        }
        
        .time-slot:hover:not(.disabled) {
            border-color: #007aff;
            background-color: #1e3a5f;
        }
        
        .time-slot.selected {
            background-color: #007aff;
            border-color: #007aff;
        }
        
        .time-slot.disabled {
            background-color: #1a1a1a;
            border-color: #2a2a2a;
            color: #666;
            cursor: not-allowed;
            text-decoration: line-through;
        }
        
        .submit-button {
            width: 100%;
            padding: 15px;
            background-color: #007aff;
            color: white;
            border: none;
            border-radius: 8px;
            font-size: 16px;
            font-weight: 600;
            cursor: pointer;
            transition: all 0.2s;
            margin-top: 20px;
        }
        
        .submit-button:hover:not(:disabled) {
            background-color: #0056cc;
            transform: translateY(-1px);
            box-shadow: 0 4px 12px rgba(0, 122, 255, 0.3);
        }
        
        .submit-button:disabled {
            background-color: #666;
            cursor: not-allowed;
            transform: none;
        }
        
        .message {
            padding: 15px;
            border-radius: 8px;
            margin-bottom: 20px;
            font-size: 14px;
            animation: slideIn 0.3s ease-out;
        }

        .consent-box {
          background-color: #242424;
          border: 1px solid #3d3d3d;
          border-radius: 10px;
          padding: 16px;
          color: #d9d9d9;
          font-size: 13px;
          line-height: 1.5;
        }

        .consent-text {
          margin-bottom: 12px;
        }

        .consent-label {
          display: flex;
          align-items: center;
          gap: 10px;
          font-weight: 500;
          font-size: 14px;
        }

        .consent-label input[type="checkbox"] {
          width: 18px;
          height: 18px;
          accent-color: #007aff;
        }
        
          #buttonMessageWrapper {
            display: flex;
            flex-direction: column;
            align-items: flex-start;
            gap: 12px;
            margin-top: 20px;
          }
        
          #buttonMessageArea {
            width: 100%;
          }

        #buttonMessageArea:empty {
          display: none;
        }

          #buttonMessageWrapper .message {
            margin: 0;
            width: 100%;
          }
        
        @keyframes slideIn {
            from {
                opacity: 0;
                transform: translateY(-10px);
            }
            to {
                opacity: 1;
                transform: translateY(0);
            }
        }
        
        .message.success {
            background-color: #10b981;
            color: white;
        }
        
        .message.error {
            background-color: #ff3b30;
            color: white;
        }
        
        .loading {
            text-align: center;
            color: #999;
            padding: 20px;
        }
        
        .required {
            color: #ff3b30;
        }
    </style>
</head>
<body>
    <div class="booking-container">
        <div class="booking-header">
            <h1>📅 Rejestracja na Badanie w Lab SWPS</h1>
            <p>Wybierz dogodny termin i uzupełnij swoje dane</p>
        </div>
        
        <div class="booking-content">
            <div id="messageArea"></div>
            
            <form id="bookingForm">
                <div class="form-section">
                    <h2>Wybierz datę</h2>
                    <div class="date-picker-container">
                        <div class="date-help" id="dateHelp">💡 Kliknij ikonę kalendarza po prawej stronie, aby wybrać datę.</div>
                      <input type="date" id="datePicker" required aria-describedby="dateHelp" min="2025-11-24" max="2025-12-05">
                    </div>
                </div>
                
                <div class="form-section">
                    <h2>Wybierz godzinę</h2>
                    <div id="timeSlotsContainer" class="loading">
                        Loading available time slots...
                    </div>
                    <input type="hidden" id="selectedTime" name="timeSlot">
                </div>
                
                <div class="form-section">
                    <h2>Dane uczestnika</h2>
                    
                    <div class="form-group">
                      <label for="name">Imię i nazwisko <span class="required">*</span></label>
                      <input type="text" id="name" name="name" placeholder="Wpisz imię i nazwisko" required>
                    </div>
                    
                    <div class="form-group">
                      <label for="email">Adres e-mail <span class="required">*</span></label>
                      <input type="email" id="email" name="email" placeholder="twoj.email@przyklad.com" required>
                    </div>
                    
                    <div class="form-group">
                      <label for="gender">Płeć <span class="required">*</span></label>
                        <select id="gender" name="gender" required>
                        <option value="">Wybierz płeć</option>
                        <option value="male">Mężczyzna</option>
                        <option value="female">Kobieta</option>
                        <option value="non-binary">Osoba niebinarna</option>
                        <option value="prefer-not-to-say">Wolę nie podawać</option>
                        </select>
                    </div>
                    
                    <div class="form-group">
                      <label for="age">Wiek <span class="required">*</span></label>
                      <input type="number" id="age" name="age" placeholder="Podaj swój wiek" min="18" max="120" required>
                    </div>

                    <div class="form-group">
                      <label for="education">Wykształcenie <span class="required">*</span></label>
                      <select id="education" name="education" required>
                        <option value="">Wybierz opcję</option>
                        <option value="higher">wyższe</option>
                        <option value="studies">studiuję</option>
                        <option value="other">inne</option>
                      </select>
                    </div>

                    <div class="form-group checkbox-group">
                      <label for="nativePolish">
                        <input type="checkbox" id="nativePolish" name="nativePolish" required>
                        Język polski jest moim pierwszym / ojczystym językiem
                      </label>
                    </div>
                </div>

                  <div class="form-section">
                    <div class="consent-box">
                      <p class="consent-text">
          Administratorem danych osobowych jest Uniwersytet SWPS z siedzibą przy ul. Chodakowskiej 19/31, 03-815 Warszawa. Dane będą przetwarzane w celu rejestracji i organizacji badania naukowego na podstawie udzielonej zgody (art. 6 ust. 1 lit. a RODO). Przysługuje prawo dostępu do danych, ich sprostowania, usunięcia, ograniczenia przetwarzania, przeniesienia, sprzeciwu oraz wycofania zgody w dowolnym momencie bez wpływu na zgodność z prawem przetwarzania przed wycofaniem zgody. Przysługuje także prawo wniesienia skargi do Prezesa UODO. Kontakt do Inspektora Ochrony Danych: iod@swps.edu.pl. Podanie danych jest dobrowolne, ale niezbędne do udziału w badaniu.
                      </p>
                      <label class="consent-label">
                        <input type="checkbox" id="consentCheckbox" required> Zgoda na przetwarzanie danych osobowych — Wyrażam zgodę
                      </label>
                    </div>
                  </div>
                
                <div id="buttonMessageWrapper">
                  <button type="submit" class="submit-button" id="submitButton">
                    Zarezerwuj termin
                  </button>
                  <div id="buttonMessageArea" role="status" aria-live="polite"></div>
                </div>
            </form>
        </div>
    </div>

    <script>
        let availableSlots = [];
        let selectedTimeSlot = null;
        let selectedDate = null;

      function normalizeEmail(value) {
        return typeof value === 'string' ? value.trim().toLowerCase() : '';
      }

      function isValidEmail(value) {
        const trimmed = normalizeEmail(value);
        if (!trimmed) {
          return false;
        }

        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        return emailRegex.test(trimmed);
      }

      function isValidAdultAge(value) {
        const parsed = Number.parseInt(value, 10);
        return Number.isInteger(parsed) && parsed >= 18 && parsed <= 120;
      }

        function formatDateForDisplay(dateStr) {
            const date = new Date(dateStr + 'T00:00:00');
            return date.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
        }

        function setLoadingState() {
            const container = document.getElementById('timeSlotsContainer');
            if (!container) return;
            container.className = 'loading';
          container.innerHTML = 'Ładowanie dostępnych terminów...';
        }

        function updateSubmitButtonState() {
            const submitButton = document.getElementById('submitButton');
            if (!submitButton) return;
            submitButton.disabled = availableSlots.length === 0;
        }

        function resetTimeSelection() {
            selectedTimeSlot = null;
            const hiddenInput = document.getElementById('selectedTime');
            if (hiddenInput) hiddenInput.value = '';
            document.querySelectorAll('.time-slot.selected').forEach(el => el.classList.remove('selected'));
        }

        async function loadAvailableSlots(requestedDate) {
            setLoadingState();
            resetTimeSelection();
            availableSlots = [];
            updateSubmitButtonState();

            try {
                const query = requestedDate ? '?date=' + encodeURIComponent(requestedDate) : '';
                const response = await fetch('/available-slots' + query);
                const data = await response.json();

                if (response.ok) {
                    const datePicker = document.getElementById('datePicker');
                    const dateHelp = document.getElementById('dateHelp');

                    selectedDate = data.date;
                    availableSlots = data.availableSlots || [];

                    if (datePicker) {
                        datePicker.min = data.minDate;
                        datePicker.max = data.maxDate;
                        datePicker.value = data.date;
                    }

                    if (dateHelp) {
                      dateHelp.textContent = '💡 Kliknij ikonę kalendarza po prawej stronie, aby wybrać datę.';
                    }

                    renderTimeSlots();
                } else {
                    const errorMessage = data.error || 'Nie udało się pobrać terminów.';
                    showMessage('Błąd podczas ładowania terminów: ' + errorMessage, 'error');
                    const container = document.getElementById('timeSlotsContainer');
                    if (container) {
                        container.className = 'loading';
                        container.innerHTML = errorMessage;
                    }
                }
            } catch (error) {
                  showMessage('Nie udało się połączyć z serwerem', 'error');
                console.error('Error:', error);
                const container = document.getElementById('timeSlotsContainer');
                if (container) {
                    container.className = 'loading';
                    container.innerHTML = 'Nie udało się pobrać terminów.';
                }
            }
        }

        function renderTimeSlots() {
            const container = document.getElementById('timeSlotsContainer');
            if (!container) return;

            container.innerHTML = '';
            container.className = 'time-slots';

            if (!selectedDate) {
              container.innerHTML = '<p style="color: #999; text-align: center; padding: 20px;">Wybierz datę, aby zobaczyć dostępne godziny.</p>';
                updateSubmitButtonState();
                return;
            }

            if (availableSlots.length === 0) {
              container.innerHTML = '<p style="color: #999; text-align: center; padding: 20px;">Wszystkie godziny na ' + formatDateForDisplay(selectedDate) + ' są zajęte. Wybierz inny dzień.</p>';
                updateSubmitButtonState();
                return;
            }

            const allSlots = ['08:00', '09:00', '10:00', '11:00', '12:00', '13:00', '14:00', '15:00', '16:00', '17:00', '18:00', '19:00'];

            allSlots.forEach(slot => {
                const slotDiv = document.createElement('div');
                const isAvailable = availableSlots.includes(slot);

                slotDiv.className = 'time-slot' + (isAvailable ? '' : ' disabled');
                slotDiv.textContent = slot;

                if (isAvailable) {
                    slotDiv.onclick = function () {
                        selectTimeSlot(slot, slotDiv);
                    };
                }

                container.appendChild(slotDiv);
            });

            updateSubmitButtonState();
        }

        function selectTimeSlot(slot, element) {
            document.querySelectorAll('.time-slot.selected').forEach(el => el.classList.remove('selected'));

            element.classList.add('selected');
            selectedTimeSlot = slot;
            const hiddenInput = document.getElementById('selectedTime');
            if (hiddenInput) hiddenInput.value = slot;
        }

        function showMessage(text, type) {
          const successArea = document.getElementById('buttonMessageArea');
          const defaultArea = document.getElementById('messageArea');

          if (type !== 'success' && successArea) {
            successArea.innerHTML = '';
          }

          const targetArea = type === 'success' ? successArea : defaultArea;
          if (!targetArea) {
            return;
          }

          const messageDiv = document.createElement('div');
          messageDiv.className = 'message ' + type;
          messageDiv.textContent = text;

          targetArea.innerHTML = '';
          targetArea.appendChild(messageDiv);

          if (type !== 'success') {
            setTimeout(function () {
              if (messageDiv.parentElement === targetArea) {
                messageDiv.remove();
              }
            }, 5000);
          }
        }

        const datePickerElement = document.getElementById('datePicker');
        const datePickerContainer = document.querySelector('.date-picker-container');

        if (datePickerElement) {
          let isOpeningPicker = false;

          const openDatePicker = () => {
            if (isOpeningPicker) {
              return;
            }

            isOpeningPicker = true;

            const finish = () => {
              setTimeout(() => {
                isOpeningPicker = false;
              }, 50);
            };

            if (typeof datePickerElement.showPicker === 'function') {
              try {
                datePickerElement.showPicker();
                finish();
                return;
              } catch (pickerError) {
                // Ignore and fall back to focus/click
              }
            }

            datePickerElement.focus({ preventScroll: true });
            const clickEvent = new MouseEvent('click', { bubbles: true, cancelable: true });
            datePickerElement.dispatchEvent(clickEvent);
            finish();
          };

          if (datePickerContainer) {
            datePickerContainer.addEventListener('click', function (event) {
              if (event.target !== datePickerElement) {
                openDatePicker();
              }
            });
          }

          datePickerElement.addEventListener('mousedown', function (event) {
            if (event.button === 0) {
              event.preventDefault();
              openDatePicker();
            }
          });

          datePickerElement.addEventListener('click', function () {
            openDatePicker();
          });

          ['focus', 'touchstart'].forEach(function (eventName) {
            datePickerElement.addEventListener(eventName, function () {
              openDatePicker();
            });
          });

          datePickerElement.addEventListener('keydown', function (event) {
            if (event.key === ' ' || event.key === 'Enter') {
              event.preventDefault();
              openDatePicker();
            }
          });
        }

        if (datePickerElement) {
            datePickerElement.addEventListener('change', function (e) {
                const newDate = e.target.value;
                loadAvailableSlots(newDate);
            });
        }

        document.getElementById('bookingForm').addEventListener('submit', async function (e) {
            e.preventDefault();

            const datePicker = document.getElementById('datePicker');
            selectedDate = datePicker ? datePicker.value : null;

            if (!selectedDate) {
                showMessage('Wybierz datę', 'error');
                return;
            }

            if (!selectedTimeSlot) {
                showMessage('Wybierz godzinę', 'error');
                return;
            }

            const submitButton = document.getElementById('submitButton');
            const nameInput = document.getElementById('name');
            const emailInput = document.getElementById('email');
            const genderInput = document.getElementById('gender');
            const ageInput = document.getElementById('age');
            const educationSelect = document.getElementById('education');
            const consentCheckbox = document.getElementById('consentCheckbox');
            const nativePolishCheckbox = document.getElementById('nativePolish');

            const emailValue = emailInput ? emailInput.value : '';
            const ageValue = ageInput ? ageInput.value : '';

            if (!isValidEmail(emailValue)) {
              showMessage('Podaj poprawny adres e-mail', 'error');
              return;
            }

            if (!isValidAdultAge(ageValue)) {
              showMessage('Rezerwacji mogą dokonać wyłącznie osoby pełnoletnie (18+).', 'error');
              return;
            }

            if (!educationSelect || !educationSelect.value) {
              showMessage('Wybierz poziom wykształcenia.', 'error');
              return;
            }

            if (!consentCheckbox || !consentCheckbox.checked) {
              showMessage('Aby kontynuować, zaakceptuj przetwarzanie danych osobowych.', 'error');
              return;
            }

            if (!nativePolishCheckbox || !nativePolishCheckbox.checked) {
              showMessage('Potwierdź, że język polski jest Twoim pierwszym językiem.', 'error');
              return;
            }

            submitButton.disabled = true;
            submitButton.textContent = 'Trwa rezerwacja...';

            const reservedTime = selectedTimeSlot;
            const reservedDate = selectedDate;

            const formData = {
                date: reservedDate,
                timeSlot: reservedTime,
              name: nameInput ? nameInput.value : '',
              email: emailValue.trim(),
              gender: genderInput ? genderInput.value : '',
              age: Number.parseInt(ageValue, 10),
              education: educationSelect ? educationSelect.value : '',
              nativePolishSpeaker: nativePolishCheckbox ? nativePolishCheckbox.checked : false
            };

            try {
                const response = await fetch('/book', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify(formData)
                });

                const data = await response.json();

                if (response.ok) {
                  let successText = data.replacedExistingBooking
                    ? '🔁 Zaktualizowano! Twoja wizyta została ustawiona na ' + formatDateForDisplay(reservedDate) + ' o ' + reservedTime + '. '
                    : '✅ Sukces! Twoja wizyta została zarezerwowana na ' + formatDateForDisplay(reservedDate) + ' o ' + reservedTime + '. ';

                  if (data.message) {
                    successText += data.message;
                  }

                  showMessage(successText.trim(), 'success');

                    document.getElementById('name').value = '';
                    document.getElementById('email').value = '';
                    document.getElementById('gender').value = '';
                    document.getElementById('age').value = '';
                    if (educationSelect) {
                      educationSelect.value = '';
                    }
                    if (nativePolishCheckbox) {
                      nativePolishCheckbox.checked = false;
                    }
                    if (consentCheckbox) {
                      consentCheckbox.checked = false;
                    }
                    resetTimeSelection();

                    setTimeout(function () {
                        loadAvailableSlots(reservedDate);
                    }, 500);
                } else {
                  showMessage('Błąd: ' + (data.error || 'Nie udało się zrealizować rezerwacji'), 'error');
                }
            } catch (error) {
                showMessage('Nie udało się zarezerwować wizyty. Spróbuj ponownie.', 'error');
                console.error('Error:', error);
            } finally {
                submitButton.disabled = false;
                submitButton.textContent = 'Zarezerwuj termin';
            }
        });

        window.addEventListener('load', function () {
            loadAvailableSlots();
        });
    </script>
</body>
</html>
  `)
})

app.get('/available-slots', async (req, res) => {
  try {
    const bounds = getDateBounds()
    const requestedDate = typeof req.query.date === 'string' ? req.query.date : ''
    const date = isValidBookingDate(requestedDate) ? requestedDate : bounds.minDate

    const bookings = await loadBookings()
    const bookedSlots = bookings
      .filter(booking => {
        const bookingDate = booking.date || (booking.timestamp ? toDateOnlyString(new Date(booking.timestamp)) : null)
        return bookingDate === date
      })
      .map(booking => booking.timeSlot)

    const availableSlots = ALL_TIME_SLOTS.filter(slot => !bookedSlots.includes(slot))

    res.json({
      date,
      minDate: bounds.minDate,
      maxDate: bounds.maxDate,
      availableSlots,
      bookedSlots
    })
  } catch (error) {
    console.error('Error getting available slots:', error)
    res.status(500).json({ error: 'Nie udało się pobrać dostępnych terminów' })
  }
})

app.get('/calendar.ics', async (req, res) => {
  try {
    const bookings = await loadBookings()

    if (!bookings || bookings.length === 0) {
      return res.status(404).send('Brak rezerwacji do eksportu')
    }

    const sortedBookings = [...bookings].sort((a, b) => {
      if (a.date === b.date) {
        return a.timeSlot.localeCompare(b.timeSlot)
      }
      return a.date.localeCompare(b.date)
    })

    const events = []

    for (const booking of sortedBookings) {
      if (!booking.date || !booking.timeSlot) {
        continue
      }

      const [year, month, day] = booking.date.split('-').map(Number)
      const [hour, minute] = booking.timeSlot.split(':').map(Number)

      if ([year, month, day, hour, minute].some(Number.isNaN)) {
        continue
      }

      const titleName = booking.name ? ` - ${booking.name}` : ''
      const summary = `Badanie Lab SWPS${titleName}`
      const descriptionParts = [
        `Data: ${booking.date}`,
        `Godzina: ${booking.timeSlot}`
      ]

      if (booking.name) {
        descriptionParts.push(`Imię i nazwisko: ${booking.name}`)
      }
      if (booking.email) {
        descriptionParts.push(`E-mail: ${booking.email}`)
      }
      if (booking.gender) {
        descriptionParts.push(`Płeć: ${booking.gender}`)
      }
      if (typeof booking.age !== 'undefined') {
        descriptionParts.push(`Wiek: ${booking.age}`)
      }

      if (booking.education) {
        const educationLabel = EDUCATION_LABELS[booking.education] || booking.education
        descriptionParts.push(`Wykształcenie: ${educationLabel}`)
      }

      if (typeof booking.nativePolishSpeaker !== 'undefined') {
        descriptionParts.push(`Polski jako język ojczysty: ${booking.nativePolishSpeaker ? 'Tak' : 'Nie'}`)
      }

      events.push({
        start: [year, month, day, hour, minute],
        duration: { hours: 1 },
        startInputType: 'local',
        startOutputType: 'local',
        title: summary,
        description: descriptionParts.join('\n'),
        location: 'Lab SWPS',
        productId: 'Lab SWPS Booking Calendar',
        status: 'CONFIRMED',
        calName: 'Rezerwacje Lab SWPS',
        uid: `lab-swps-${booking.id || `${booking.date}-${booking.timeSlot}`}`
      })
    }

    if (events.length === 0) {
      return res.status(404).send('Brak poprawnych danych do wygenerowania kalendarza')
    }

    const { error, value } = createEvents(events)

    if (error) {
      console.error('Błąd generowania pliku ICS:', error)
      return res.status(500).send('Nie udało się wygenerować kalendarza')
    }

    res.setHeader('Content-Type', 'text/calendar; charset=utf-8')
    res.setHeader('Content-Disposition', 'attachment; filename="lab-swps-rezerwacje.ics"')
    res.send(value)
  } catch (error) {
    console.error('Błąd tworzenia pliku ICS:', error)
    res.status(500).send('Nie udało się wygenerować kalendarza')
  }
})

app.post('/book', async (req, res) => {
  console.log('=== BOOKING REQUEST START ===')
  console.log('Incoming booking request received')

  try {
    const { date, timeSlot, name, email, gender, age, education, nativePolishSpeaker } = req.body

    if (!date || !timeSlot || !name || !email || !gender || !education || (typeof age === 'undefined' || age === null)) {
      return res.status(400).json({ error: 'Wszystkie pola są wymagane' })
    }

    if (!isValidBookingDate(date)) {
      return res.status(400).json({ error: 'Nieprawidłowa data rezerwacji' })
    }

    if (!ALL_TIME_SLOTS.includes(timeSlot)) {
      return res.status(400).json({ error: 'Nieprawidłowy termin' })
    }

    const trimmedEmail = typeof email === 'string' ? email.trim() : ''
    if (!isValidEmail(trimmedEmail)) {
      return res.status(400).json({ error: 'Podaj prawidłowy adres e-mail' })
    }

    const parsedAge = parseInt(age, 10)
    if (Number.isNaN(parsedAge) || parsedAge < 18 || parsedAge > 120) {
      return res.status(400).json({ error: 'Wiek musi wynosić co najmniej 18 lat' })
    }

    if (!ALLOWED_EDUCATION_LEVELS.has(education)) {
      return res.status(400).json({ error: 'Podano nieprawidłową wartość dla wykształcenia' })
    }

    if (!nativePolishSpeaker) {
      return res.status(400).json({ error: 'Rezerwacja dostępna wyłącznie dla osób, dla których polski jest językiem ojczystym.' })
    }

    const bookings = await loadBookings()

    const normalizedIncomingEmail = normalizeEmail(trimmedEmail)
    let replacedBooking = null
    const bookingsWithoutEmail = bookings.filter(existing => {
      const matches = normalizeEmail(existing.email) === normalizedIncomingEmail
      if (matches && !replacedBooking) {
        replacedBooking = existing
      }
      return !matches
    })

    const slotBooked = bookingsWithoutEmail.some(booking => {
      const bookingDate = booking.date || (booking.timestamp ? toDateOnlyString(new Date(booking.timestamp)) : null)
      return bookingDate === date && booking.timeSlot === timeSlot
    })

    if (slotBooked) {
      return res.status(400).json({ error: 'Ten termin jest już zarezerwowany na wybraną datę' })
    }

    const newBooking = {
      id: Date.now().toString(),
      date,
      timeSlot,
      name,
      email: trimmedEmail,
      gender,
      age: parsedAge,
      education,
      nativePolishSpeaker: Boolean(nativePolishSpeaker),
      timestamp: new Date().toISOString()
    }

    // Save the new booking
    if (kv) {
      // For Vercel KV, remove previous entry for this email (if any) and save directly
      if (replacedBooking) {
        try {
          await kv.del(`booking:${replacedBooking.id}`)
        } catch (error) {
          console.error('Error removing previous booking from Vercel KV:', error)
        }
      }
      await kv.set(`booking:${newBooking.id}`, newBooking)
    } else {
      // For file system, replace existing entry (if any) then save
      const finalBookings = [...bookingsWithoutEmail, newBooking]
      await saveBookings(finalBookings)
    }

    if (resendClient) {
      // Fire-and-forget notification; we log errors inside the helper.
      void sendBookingNotification(newBooking, replacedBooking)
    }

    res.json({
      success: true,
      message: replacedBooking
        ? 'Poprzednia rezerwacja została zastąpiona nowymi danymi.'
        : 'Rezerwacja została zapisana.',
      booking: newBooking,
      replacedExistingBooking: Boolean(replacedBooking)
    })

    console.log('=== BOOKING REQUEST END (SUCCESS) ===')
  } catch (error) {
    console.error('=== BOOKING ERROR ===')
    console.error('Error creating booking:', error)
    res.status(500).json({ error: 'Nie udało się zapisać rezerwacji' })
  }
})

if (require.main === module) {
  app.listen(port, () => {
    console.log(`Booking Calendar app listening on port ${port}`)
    console.log(`Open http://localhost:${port} in your browser`)
  })
}

module.exports = app
