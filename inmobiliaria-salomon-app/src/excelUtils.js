import * as XLSX from 'xlsx';

/**
 * Exporta un array de objetos a un archivo Excel (.xlsx)
 * @param {Array} data - Lista de objetos a exportar
 * @param {string} fileName - Nombre del archivo (sin extensión)
 */
export const exportToExcel = (data, fileName = 'export') => {
  if (!data || data.length === 0) {
    alert('No hay datos para exportar');
    return;
  }

  const worksheet = XLSX.utils.json_to_sheet(data);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, 'Datos');

  // Generar buffer y descargar
  XLSX.writeFile(workbook, `${fileName}_${new Date().getTime()}.xlsx`);
};

/**
 * Lee un archivo Excel o CSV y devuelve una promesa con los datos en formato JSON
 * @param {File} file - El archivo seleccionado por el usuario
 * @returns {Promise<Array>} - Promesa que resuelve a un array de objetos
 */
export const importFromExcel = (file) => {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();

    reader.onload = (e) => {
      try {
        const data = e.target.result;
        const workbook = XLSX.read(data, { type: 'binary' });
        const sheetName = workbook.SheetNames[0];
        const worksheet = workbook.Sheets[sheetName];
        const json = XLSX.utils.sheet_to_json(worksheet);
        resolve(json);
      } catch (error) {
        reject(error);
      }
    };

    reader.onerror = (error) => reject(error);
    reader.readAsBinaryString(file);
  });
};
