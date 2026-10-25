const express = require('express');
const axios = require('axios'); // Para hacer peticiones a la API de Mercado Pago
const app = express();
app.use(express.json());

// Base de datos simple en memoria (luego la conectamos a SQLite o Firebase)
let users = {
    'user_001': { balance: 0 }
};

// Endpoint principal: Recibe la confirmación de pago desde Mercado Pago
app.post('/webhook/pago', async (req, res) => {
    try {
        const paymentId = req.body.id;
        
        // 1. Verificamos el estado del pago con la API oficial
        const response = await axios.get(`https://api.mercadopago.com/v1/payments/${paymentId}`, {
            headers: {
                'Authorization': `Bearer TU_ACCESS_TOKEN_DE_MERCADO_PAGO` 
            }
        });

        const paymentData = response.data;

        // 2. Si el pago está aprobado...
        if (paymentData.status === 'approved') {
            const amount = paymentData.transaction_amount;
            const userId = paymentData.external_reference; // Este ID lo enviamos desde tu web al crear el pago

            // 3. Actualizamos el saldo automáticamente
            if (users[userId]) {
                users[userId].balance += amount;
                console.log(`✅ Usuario ${userId} ahora tiene ${users[userId].balance} Gs.`);
            } else {
                console.log(`⚠️ Usuario ${userId} no encontrado en la base de datos.`);
            }
        }
        
        res.status(200).send('OK - Saldo Actualizado');
    } catch (error) {
        console.error('Error procesando webhook:', error);
        res.status(500).send('Error');
    }
});

// Endpoint para crear un pago (cuando el usuario hace clic en "Depositar")
app.post('/api/crear-pago', async (req, res) => {
    const { userId, amount } = req.body;

    try {
        const response = await axios.post('https://api.mercadopago.com/checkout/preferences', {
            items: [{
                title: `Depósito Casino Clave`,
                unit_price: amount,
                quantity: 1,
                currency_id: 'PYG' // Peso Paraguayo
            }],
            external_reference: userId, // Esto es clave para saber a quién acreditar
            back_urls: [
                { url: "https://tu-web-casino-clave.com/callback", status_code: 200 }
            ],
            auto_return: "approved"
        }, {
            headers: {
                'Authorization': `Bearer TU_ACCESS_TOKEN_DE_MERCADO_PAGO`
            }
        });

        res.json({ init_point: response.data.init_point });
    } catch (error) {
        res.status(500).json({ error: 'Error creando el pago' });
    }
});

app.listen(3000, () => {
    console.log('🎰 Casino Clave Backend corriendo en puerto 3000');
});
