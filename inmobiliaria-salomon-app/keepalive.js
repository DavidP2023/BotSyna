import { createClient } from '@supabase/supabase-js'

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
)

async function keepAlive() {
  const { error } = await supabase.from('propiedades_v2').select('*').limit(1)
  if (error) {
    console.error('Error al consultar:', error.message)
    process.exit(1)
  } else {
    console.log('Ping exitoso, proyecto activo')
  }
}

keepAlive()
